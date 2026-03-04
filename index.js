require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");

// Pull env vars (Railway + local)
const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",
  TARGET_CHANNEL_ID,
  // Railway-style Google vars:
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
} = process.env;

if (!SLACK_SIGNING_SECRET || !SLACK_BOT_TOKEN) {
  throw new Error("Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN");
}
if (!SHEET_ID) {
  throw new Error("Missing SHEET_ID");
}
if (!TARGET_CHANNEL_ID) {
  throw new Error("Missing TARGET_CHANNEL_ID");
}
if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");
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
  // Railway often stores multiline keys with literal "\n"
  const key = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key,
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
 * Handles normal new top-level messages in the target channel.
 * This is useful if you want it to react to regular posts.
 */
app.event("message", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;

    // Only new top-level posts
    if (event.thread_ts) return;

    // Allow Workflow bot messages (subtype=bot_message); skip edits/deletes/etc.
    if (event.subtype && event.subtype !== "bot_message") return;

    // Ignore our own bot messages
    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return;

    await postOnCallReply({
      channel: event.channel,
      thread_ts: event.ts,
      logger,
    });
  } catch (err) {
    logger.error(err);
  }
});

/**
 * Handles workflow posts that @mention the bot.
 * Your workflow payload is "type": "app_mention", so this is critical.
 */
app.event("app_mention", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;

    // If the mention is already in a thread, reply in that thread.
    // Otherwise reply in a new thread attached to the mention message.
    const threadTs = event.thread_ts || event.ts;

    // Ignore our own bot messages (rare here, but safe)
    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return;

    await postOnCallReply({
      channel: event.channel,
      thread_ts: threadTs,
      logger,
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