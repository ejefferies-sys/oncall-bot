const crypto = require("crypto");
const { WebClient } = require("@slack/web-api");
const { google } = require("googleapis");

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  TARGET_CHANNEL_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",
  GOOGLE_CREDENTIALS,
} = process.env;

if (!SLACK_SIGNING_SECRET) throw new Error("Missing SLACK_SIGNING_SECRET");
if (!SLACK_BOT_TOKEN) throw new Error("Missing SLACK_BOT_TOKEN");
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!TARGET_CHANNEL_ID) throw new Error("Missing TARGET_CHANNEL_ID");
if (!GOOGLE_CREDENTIALS) throw new Error("Missing GOOGLE_CREDENTIALS");

const slack = new WebClient(SLACK_BOT_TOKEN);

function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  const privateKey = creds.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getCurrentOnCallEmail() {
  console.log("Starting sheet lookup");
  console.log("Using SHEET_ID:", SHEET_ID);
  console.log("Using CURRENT_CELL_RANGE:", CURRENT_CELL_RANGE);

  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: CURRENT_CELL_RANGE,
  });

  console.log("Sheet API call succeeded");
  console.log("Raw sheet response:", JSON.stringify(resp.data));

  const value = resp.data.values?.[0]?.[0];
  const email = (value || "").toString().trim();

  if (!email || !email.includes("@")) {
    throw new Error(`Cell ${CURRENT_CELL_RANGE} is empty or not an email.`);
  }

  console.log("Parsed on-call email:", email);
  return email;
}

async function lookupSlackUserIdByEmail(email) {
  console.log("Looking up Slack user by email:", email);
  const res = await slack.users.lookupByEmail({ email });
  const userId = res.user?.id || null;
  console.log("Resolved Slack user ID:", userId);
  return userId;
}

function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) return false;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(timestamp) < fiveMinutesAgo) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto
      .createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(base, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch {
    return false;
  }
}

function isTargetWorkflowMessage(event) {
  if (!event) return false;
  if (event.channel !== TARGET_CHANNEL_ID) return false;
  if (event.type !== "message") return false;
  if (event.subtype !== "bot_message") return false;
  return true;
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).send("ok");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const body = typeof req.body === "object" ? req.body : JSON.parse(rawBody);

    if (body.type === "url_verification" && body.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    // TEMPORARY: bypass signature verification while testing.
    // Re-enable once everything is confirmed working.
    // const valid = verifySlackSignature(req, rawBody);
    // if (!valid) {
    //   return res.status(401).send("Invalid signature");
    // }

    if (body.type !== "event_callback") {
      console.log("Ignoring non-event_callback body type:", body.type);
      return res.status(200).send("ok");
    }

    const event = body.event;

    console.log("BODY TYPE:", body.type);
    console.log("EVENT:", JSON.stringify(event));
    console.log("TARGET_CHANNEL_ID:", TARGET_CHANNEL_ID);

    if (!event) {
      console.log("No event found");
      return res.status(200).send("ok");
    }

    if (event.channel !== TARGET_CHANNEL_ID) {
      console.log("Channel mismatch:", event.channel, "!=", TARGET_CHANNEL_ID);
      return res.status(200).send("ok");
    }

    if (!isTargetWorkflowMessage(event)) {
      console.log(
        "Ignoring event:",
        "type=", event.type,
        "subtype=", event.subtype
      );
      return res.status(200).send("ok");
    }

    console.log("Matched workflow bot message");

    const email = await getCurrentOnCallEmail();
    const userId = await lookupSlackUserIdByEmail(email);

    const messageText = userId
      ? `On call: <@${userId}>`
      : `On call: ${email} (couldn’t map email to Slack user)`;

    console.log("Attempting to post message...");
    console.log("Posting to channel:", event.channel);
    console.log("Original event ts:", event.ts);
    console.log("Original thread_ts:", event.thread_ts || null);
    console.log("Message text:", messageText);

    // FOR TESTING: post directly in channel, not thread
    const result = await slack.chat.postMessage({
      channel: event.channel,
      text: messageText,
    });

    console.log("Slack API response:", JSON.stringify(result));
    console.log("Posted message successfully:", result.ts);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Slack handler error:", err);
    return res.status(500).send("Internal Server Error");
  }
};
