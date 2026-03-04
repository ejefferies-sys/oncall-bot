require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  TARGET_CHANNEL_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",

  // Railway/prod preferred:
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,

  // Local fallback (optional):
  GOOGLE_CREDENTIALS_FILE = "google-credentials.json",
} = process.env;

if (!SLACK_SIGNING_SECRET || !SLACK_BOT_TOKEN) {
  throw new Error("Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN");
}
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!TARGET_CHANNEL_ID) throw new Error("Missing TARGET_CHANNEL_ID");

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });

// ✅ Healthcheck endpoints for Railway
receiver.app.get("/", (req, res) => res.status(200).send("ok"));
receiver.app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Default endpoint is /slack/events (matches your Slack Event Subscriptions URL)
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

let SELF_USER_ID = null;

async function ensureSelfUserId() {
  if (SELF_USER_ID) return SELF_USER_ID;
  const res = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  SELF_USER_ID = res.user_id;
  return SELF_USER_ID;
}

function getSheetsClient() {
  let email = GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = GOOGLE_PRIVATE_KEY;

  if (email && key) {
    // Railway often stores multiline secrets with literal "\n"
    key = key.replace(/\\n/g, "\n");
  } else {
    // Local dev fallback: google-credentials.json in the project folder
    const creds = require(`./${GOOGLE_CREDENTIALS_FILE}`);
    email = creds.client_email;
    key = creds.private_key;
  }

  if (!email || !key) {
    throw new Error(
      "Missing Google credentials. Provide GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY, or google-credentials.json."
    );
  }

  const auth = new google.auth.JWT({
    email,
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
}

/**
 * Trigger #1: ANY new top-level message in the channel
 */
app.event("message", async ({ event, logger }) => {
  try {
    if (event.channel !== TARGET_CHANNEL_ID) return;

    // only new top-level posts
    if (event.thread_ts) return;

    // ignore message edits/deletes/etc.
    if (event.subtype && event.subtype !== "bot_message") return;

    // ignore our own bot messages (prevents loops)
    const selfUserId = await ensureSelfUserId();
    if (event.user && event.user === selfUserId) return;

    await postOnCallReply({ channel: event.channel, thread_ts: event.ts, logger });
  } catch (err) {
    logger?.error(err);
  }
});

/**
 * Trigger #2: @mention of the bot in the channel
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

  // IMPORTANT: Bolt's app.start starts its own express app, but since we are using ExpressReceiver
  // we should explicitly start the receiver to guarantee the port is bound in Railway.
  await receiver.start(port);

  console.log(`⚡️ On-call bot listening on port ${port}`);
})();