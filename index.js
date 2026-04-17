require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();

// Log every incoming request for debugging
app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

// Capture raw body for Slack signature verification before any parsing
app.use('/slack/commands', express.raw({ type: '*/*' }));
app.use(express.json());

const {
  FIGMA_PASSCODE,
  SLACK_WEBHOOK_URL,
  SLACK_SIGNING_SECRET,
  FIGMA_TOKEN,
  RENDER_URL,
  PORT,
} = process.env;

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

function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const rawBody = req.body.toString();
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBase).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

function extractFileKey(url) {
  const match = url.match(/figma\.com\/(?:file|board|design)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function registerFigmaWebhook(file_key, event_type) {
  const body = {
    event_type,
    context: 'file',
    context_id: file_key,
    endpoint: `${RENDER_URL}/webhook`,
    passcode: FIGMA_PASSCODE,
  };
  const { data } = await axios.post('https://api.figma.com/v2/webhooks', body, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN, 'Content-Type': 'application/json' },
  });
  return data.id;
}

app.get('/health', (_req, res) => res.sendStatus(200));

// /add-file <figma-url> — registers webhooks for a new file without touching code
app.post('/slack/commands', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).send('Unauthorized');
  }

  const params = new URLSearchParams(req.body.toString());
  const command = params.get('command');
  const text = (params.get('text') ?? '').trim();

  if (command !== '/add-file') {
    return res.json({ response_type: 'ephemeral', text: `Unknown command: ${command}` });
  }

  if (!text) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/add-file <figma-url>`' });
  }

  const file_key = extractFileKey(text);
  if (!file_key) {
    return res.json({ response_type: 'ephemeral', text: `Could not extract a file key from: ${text}` });
  }

  if (!FIGMA_TOKEN || !RENDER_URL) {
    return res.json({ response_type: 'ephemeral', text: 'Server is missing FIGMA_TOKEN or RENDER_URL env vars.' });
  }

  const response_url = params.get('response_url');

  // Acknowledge Slack immediately — must respond within 3 seconds
  res.json({ response_type: 'ephemeral', text: `Registering webhooks for \`${file_key}\`...` });

  // Do Figma API work in background, then post result back via response_url
  (async () => {
    try {
      const [commentId, updateId] = await Promise.all([
        registerFigmaWebhook(file_key, 'FILE_COMMENT'),
        registerFigmaWebhook(file_key, 'FILE_UPDATE'),
      ]);
      console.log(`[/add-file] Registered webhooks for ${file_key} — comment: ${commentId}, update: ${updateId}`);
      await axios.post(response_url, {
        response_type: 'in_channel',
        text: `Now monitoring \`${file_key}\`\nFILE_COMMENT webhook ID: ${commentId}\nFILE_UPDATE webhook ID: ${updateId}`,
      });
    } catch (err) {
      const message = err.response?.data?.message ?? err.message;
      console.error(`[/add-file] Failed to register webhooks for ${file_key}: ${message}`);
      await axios.post(response_url, {
        response_type: 'ephemeral',
        text: `Failed to register webhooks: ${message}`,
      });
    }
  })();
});

app.post('/webhook', async (req, res) => {
  const { passcode, event_type, file_key, comment, triggered_by } = req.body;
  if (!passcode || passcode !== FIGMA_PASSCODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (event_type === 'PING') {
    return res.status(200).send('OK');
  }

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
