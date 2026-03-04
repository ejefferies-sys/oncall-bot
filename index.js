require("dotenv").config();

process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("SIGTERM", () => {
  console.log("SIGTERM received (Railway is stopping the container)");
  process.exit(0);
});

const { App, ExpressReceiver } = require("@slack/bolt");
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

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });

// health checks
receiver.app.get("/", (req, res) => res.status(200).send("ok"));
receiver.app.get("/healthz", (req, res) => res.status(200).send("ok"));

// create the Bolt app BEFORE using app.event(...)
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

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
  if (!email || !email.includes("@")) throw new Error(`Cell ${CURRENT_CELL_RANGE} is empty or not an email.`);
  return email;
}

async function lookupSlackUserIdByEmail(email) {
  const res = await app.client.users.lookupByEmail({ token: SLACK_BOT_TOKEN, email });
  return res.user?.id || null;
}

let SELF_USER_ID = null;
async function ensureSelfUserId() {
  if (SELF_USER_ID) return SELF_USER_ID;
  const res = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
  SELF_USER_ID = res.user_id;
  return SELF_USER_ID;
}

async function postOnCallReply({ channel, thread_ts, logger }) {
  try {
    const email = await getCurrentOnCallEmail();
    const userId = await lookupSlackUserIdByEmail(email);

    await app.client.chat.postMessage({
      token: SLACK_BOT_TOKEN,
      channel,
      thread_ts,
      text: userId ? `On call: <@${userId}>` : `On call: ${email} (couldn’t map email to Slack user)`,
    });
  } catch (err) {
    logger?.error(err);
  }
}

app.event("message", async ({ event, logger }) => {
  if (event.channel !== TARGET_CHANNEL_ID) return;
  if (event.thread_ts) return;
  if (event.subtype && event.subtype !== "bot_message") return;

  const selfUserId = await ensureSelfUserId();
  if (event.user && event.user === selfUserId) return;

  await postOnCallReply({ channel: event.channel, thread_ts: event.ts, logger });
});

app.event("app_mention", async ({ event, logger }) => {
  if (event.channel !== TARGET_CHANNEL_ID) return;

  const selfUserId = await ensureSelfUserId();
  if (event.user && event.user === selfUserId) return;

  await postOnCallReply({ channel: event.channel, thread_ts: event.thread_ts || event.ts, logger });
});

(async () => {
  const port = Number(process.env.PORT || 3000);
  console.log("PORT env is:", process.env.PORT, "-> binding to:", port);
  await app.start(port);
  console.log(`⚡️ On-call bot listening on port ${port}`);
})();
