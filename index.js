require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  TARGET_CHANNEL_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",

  // ✅ Use ONE env var that contains the whole JSON (service account key)
  GOOGLE_CREDENTIALS,
} = process.env;

if (!SLACK_SIGNING_SECRET) throw new Error("Missing SLACK_SIGNING_SECRET");
if (!SLACK_BOT_TOKEN) throw new Error("Missing SLACK_BOT_TOKEN");
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!TARGET_CHANNEL_ID) throw new Error("Missing TARGET_CHANNEL_ID");
if (!GOOGLE_CREDENTIALS) throw new Error("Missing GOOGLE_CREDENTIALS");

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });

// ✅ Healthcheck endpoints for Railway
receiver.app.get("/", (req, res) => res.status(200).send("ok"));
receiver.app.get("/healthz", (req, res) => res.status(200).send("ok"));

const app = new App({ token: SLACK_BOT_TOKEN, receiver });

let SELF_USER_ID = null;
async function ensureSelfUserId() {
  if (SELF_USER_ID) return SELF_USER_ID;
  const res = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  SELF_USER_ID = res.user_id;
  return SELF_USER_ID;
}

function getSheetsClient() {
  const raw = process.env.GOOGLE_CREDENTIALS;

  if (!raw) {
    throw new Error("Missing GOOGLE_CREDENTIALS environment variable");
  }

  const creds = JSON.parse(raw);

  // Convert escaped newlines to real newlines
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
  const res = await app.client.users.lookupByEmail({
    token: SLACK_BOT_TOKEN,
    email,
  });
  return res.user?.id || null;
}

async function postOnCallReply({ channel, thread_ts, logger }) {
  try {
    const email = await getCurrentOnCallEmail();
    const userId = await lookupSlackUserIdByEmail(email);

    const text = userId
      ? `On call: <@${userId}>`
      : `On call: ${email} (couldn’t map this email to a Slack user)`;

    await app.client.chat.postMessage({
      token: SLACK_BOT_TOKEN,
      channel,
      thread_ts,
      text,
    });
  } catch (err) {
    logger?.error(err);
  }
}

/**
 * Trigger #1: ANY new top-level message in the target channel
 */
app.event("message", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;
    if (event.thread_ts) return; // only top-level posts
    if (event.subtype && event.subtype !== "bot_message") return; // skip edits/deletes/etc.

    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return; // avoid loops

    await postOnCallReply({ channel: event.channel, thread_ts: event.ts, logger });
  } catch (err) {
    logger?.error(err);
  }
});

/**
 * Trigger #2: @mention of the bot in the target channel
 */
app.event("app_mention", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;

    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return;

    const threadTs = event.thread_ts || event.ts;
    await postOnCallReply({ channel: event.channel, thread_ts: threadTs, logger });
  } catch (err) {
    logger?.error(err);
  }
});

(async () => {
  const port = Number(process.env.PORT || 3000);
  console.log("PORT env is:", process.env.PORT, "-> binding to:", port);

  // ✅ With ExpressReceiver, start the receiver
  await app.start(port);

  console.log(`⚡️ On-call bot listening on port ${port}`);
})();
