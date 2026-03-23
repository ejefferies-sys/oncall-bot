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
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: CURRENT_CELL_RANGE,
  });

  const value = resp.data.values?.[0]?.[0];
  const email = (value || "").toString().trim();

  if (!email || !email.includes("@")) {
    throw new Error(`Cell ${CURRENT_CELL_RANGE} is empty or not an email.`);
  }

  return email;
}

async function lookupSlackUserIdByEmail(email) {
  const res = await slack.users.lookupByEmail({ email });
  return res.user?.id || null;
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

function shouldRespondToEvent(event) {
  if (!event) return false;
  if (event.channel !== TARGET_CHANNEL_ID) return false;
  if (event.type !== "message") return false;

  // Ignore edited messages and other noisy subtypes
  if (event.subtype === "message_changed") return false;
  if (event.subtype === "message_deleted") return false;

  // Ignore this bot's own messages to prevent loops
  if (event.bot_id && event.bot_id !== "B098P07439P") {
    // allow workflow bot messages from your workflow bot,
    // ignore other bots
    return false;
  }

  // Allow:
  // - normal human messages (subtype undefined)
  // - workflow bot messages (subtype bot_message from your workflow bot)
  if (!event.subtype) return true;
  if (event.subtype === "bot_message" && event.bot_id === "B098P07439P") {
    return true;
  }

  return false;
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

    // Re-enable later once you want signature verification back
    // const valid = verifySlackSignature(req, rawBody);
    // if (!valid) {
    //   return res.status(401).send("Invalid signature");
    // }

    if (body.type !== "event_callback") {
      return res.status(200).send("ok");
    }

    const event = body.event;

    if (!shouldRespondToEvent(event)) {
      console.log(
        "Ignoring event:",
        JSON.stringify({
          type: event?.type,
          subtype: event?.subtype,
          bot_id: event?.bot_id,
          channel: event?.channel,
        })
      );
      return res.status(200).send("ok");
    }

    const email = await getCurrentOnCallEmail();
    const userId = await lookupSlackUserIdByEmail(email);

    const messageText = userId
      ? `On call: <@${userId}>`
      : `On call: ${email} (couldn’t map email to Slack user)`;

    const threadTs = event.thread_ts || event.ts;

    const result = await slack.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: messageText,
    });

    console.log("Posted threaded reply successfully:", result.ts);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Slack handler error:", err);
    return res.status(500).send("Internal Server Error");
  }
};
