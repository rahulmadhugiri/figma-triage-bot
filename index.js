require('dotenv').config();

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const { FIGMA_PASSCODE, SLACK_WEBHOOK_URL, PORT } = process.env;

if (!FIGMA_PASSCODE || !SLACK_WEBHOOK_URL) {
  console.error('ERROR: FIGMA_PASSCODE and SLACK_WEBHOOK_URL must be set in environment.');
  process.exit(1);
}

// file_key → { lastUpdated: number, warningSent: boolean }
const fileTimestamps = {};

async function postToSlack(text) {
  try {
    await axios.post(SLACK_WEBHOOK_URL, { text });
  } catch (err) {
    console.error('Failed to post to Slack:', err.message);
  }
}

app.get('/health', (_req, res) => res.sendStatus(200));

app.post('/webhook', async (req, res) => {
  // Fix 1: Figma V2 sends passcode in the JSON body, not a header
  const { passcode, event_type, file_key, comment, triggered_by } = req.body;
  if (!passcode || passcode !== FIGMA_PASSCODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fix 2: Figma sends event_type "PING" during webhook registration — ACK immediately
  if (event_type === 'PING') {
    return res.status(200).send('OK');
  }

  // node_id may live at top level or inside comment[0]
  const node_id = req.body.node_id ?? comment?.[0]?.node_id ?? '';

  if (!event_type || !file_key) {
    return res.status(400).json({ error: 'Missing event_type or file_key' });
  }

  if (event_type === 'FILE_COMMENT') {
    const text = comment?.[0]?.text ?? '';
    const lower = text.toLowerCase();

    let alertType = null;
    if (lower.includes('#tech') || lower.includes('#bug')) {
      alertType = '[🚨 TECH ISSUE]';
    } else if (lower.includes('#coach') || lower.includes('#stuck')) {
      alertType = '[🙋 COACH HELP]';
    }

    if (alertType) {
      const deepLink = node_id
        ? `https://www.figma.com/file/${file_key}?node-id=${encodeURIComponent(node_id)}`
        : `https://www.figma.com/file/${file_key}`;

      const userName = triggered_by?.handle ?? triggered_by?.email ?? 'Unknown user';

      const slackMessage =
        `${alertType}\n` +
        `*User:* ${userName}\n` +
        `*Comment:* ${text}\n` +
        `*Link:* ${deepLink}`;

      await postToSlack(slackMessage);
      console.log(`[FILE_COMMENT] Alert sent for ${file_key} — ${alertType}`);
    } else {
      console.log(`[FILE_COMMENT] No trigger keyword in comment for ${file_key}, skipping.`);
    }
  } else if (event_type === 'FILE_UPDATE') {
    fileTimestamps[file_key] = { lastUpdated: Date.now(), warningSent: false };
    console.log(`[FILE_UPDATE] Timestamp reset for ${file_key}`);
  } else {
    console.log(`[WEBHOOK] Ignored event type: ${event_type}`);
  }

  res.sendStatus(200);
});

// Inactivity monitor — runs every 60 s, warns after 7 min of silence
const INACTIVITY_THRESHOLD_MS = 7 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  const now = Date.now();
  for (const [key, state] of Object.entries(fileTimestamps)) {
    if (!state.warningSent && now - state.lastUpdated > INACTIVITY_THRESHOLD_MS) {
      const msg =
        `[⚠️ INACTIVITY WARNING] File \`${key}\` has not had any edits in 7 minutes. ` +
        `They may be quietly falling behind.`;
      await postToSlack(msg);
      state.warningSent = true;
      console.log(`[INACTIVITY] Warning sent for ${key}`);
    }
  }
}, CHECK_INTERVAL_MS);

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Figma Triage Bot listening on port ${port}`);
});
