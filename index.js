require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",
  TARGET_CHANNEL_ID,
  GOOGLE_CREDENTIALS_FILE = "google-credentials.json",
} = process.env;

if (!SLACK_SIGNING_SECRET || !SLACK_BOT_TOKEN) {
  throw new Error("Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN in .env");
}
if (!SHEET_ID) {
  throw new Error("Missing SHEET_ID in .env");
}
if (!TARGET_CHANNEL_ID) {
  throw new Error("Missing TARGET_CHANNEL_ID in .env");
}

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

let SELF_USER_ID = null;

// Only ignore messages from *this* bot (not Workflow bot posts)
async function ensureSelfUserId() {
  if (SELF_USER_ID) return SELF_USER_ID;
  const res = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  SELF_USER_ID = res.user_id;
  return SELF_USER_ID;
}

function getSheetsClient() {
  const creds = require(`./${GOOGLE_CREDENTIALS_FILE}`);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
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

/**
 * Auto behavior:
 * - Only respond in TARGET_CHANNEL_ID
 * - Only new top-level posts (not thread replies)
 * - Allow Workflow bot messages (often subtype=bot_message)
 * - Ignore edits/deletes
 * - Ignore our own bot's messages to prevent loops
 */
app.event("message", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;

    if (event.thread_ts) return;

    // Allow bot_message; skip edits/deletes/etc.
    if (event.subtype && event.subtype !== "bot_message") return;

    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return;

    const email = await getCurrentOnCallEmail();
    const userId = await lookupSlackUserIdByEmail(email);

    const text = userId
      ? `On call: <@${userId}>`
      : `On call: ${email} (couldn’t map this email to a Slack user)`;

    await app.client.chat.postMessage({
      token: SLACK_BOT_TOKEN,
      channel: event.channel,
      thread_ts: event.ts,
      text,
    });
  } catch (err) {
    logger.error(err);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ On-call bot listening on port ${port}`);
})();
