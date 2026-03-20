require("dotenv").config();

const { App } = require("@slack/bolt");
const { google } = require("googleapis");

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SHEET_ID,
  TARGET_CHANNEL_ID,
  CURRENT_CELL_RANGE = "Current!A2:A2",
  GOOGLE_CREDENTIALS,
} = process.env;

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// ---------- GOOGLE SHEETS ----------
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
  return (value || "").toString().trim();
}

async function lookupSlackUserIdByEmail(email) {
  const res = await app.client.users.lookupByEmail({
    token: SLACK_BOT_TOKEN,
    email,
  });
  return res.user?.id || null;
}

// ---------- EVENT HANDLER ----------
app.event("app_mention", async ({ event, client }) => {
  if (event.channel !== TARGET_CHANNEL_ID) return;

  const email = await getCurrentOnCallEmail();
  const userId = await lookupSlackUserIdByEmail(email);

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: userId
      ? `On call: <@${userId}>`
      : `On call: ${email}`,
  });
});

// ---------- VERCEL HANDLER ----------
module.exports = async (req, res) => {
  // ✅ Slack challenge verification
  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  await app.processEvent(req, res);
};

