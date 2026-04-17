require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();

// Capture raw body for Slack signature verification before any parsing
app.use('/slack/commands', express.raw({ type: '*/*' }));
app.use('/slack/events', express.raw({ type: '*/*' }));
app.use(express.json());

const {
  FIGMA_PASSCODE,
  SLACK_WEBHOOK_URL,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  SLACK_SIGNING_SECRET,
  FIGMA_TOKEN,
  RENDER_URL,
  PORT,
} = process.env;

if (!FIGMA_PASSCODE || !SLACK_WEBHOOK_URL) {
  console.error('ERROR: FIGMA_PASSCODE and SLACK_WEBHOOK_URL must be set in environment.');
  process.exit(1);
}

// slack message ts → { file_key, comment_id, node_id }
const messageMap = new Map();

// Post to Slack — uses chat.postMessage (returns ts) if bot token is configured,
// falls back to Incoming Webhook otherwise
async function postToSlack(text) {
  try {
    if (SLACK_BOT_TOKEN && SLACK_CHANNEL_ID) {
      const { data } = await axios.post(
        'https://slack.com/api/chat.postMessage',
        { channel: SLACK_CHANNEL_ID, text },
        { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      if (!data.ok) console.error('Slack API error:', data.error);
      return data.ts ?? null;
    } else {
      await axios.post(SLACK_WEBHOOK_URL, { text });
      return null;
    }
  } catch (err) {
    console.error('Failed to post to Slack:', err.message);
    return null;
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

// Log every incoming request for debugging
app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.sendStatus(200));

// Slack Event Subscriptions — reaction_added → reply in Figma
app.post('/slack/events', (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).send('Unauthorized');
  }

  const body = JSON.parse(req.body.toString());

  // One-time URL verification handshake when setting up Event Subscriptions
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge Slack immediately
  res.sendStatus(200);

  const event = body.event;
  if (!event || event.type !== 'reaction_added') return;
  if (event.item?.type !== 'message') return;

  const TRIGGER_EMOJIS = new Set(['eyes', 'rocket', '+1', 'thumbsup']);
  if (!TRIGGER_EMOJIS.has(event.reaction)) return;

  const entry = messageMap.get(event.item.ts);
  if (!entry) {
    console.log(`[REACTION] No mapped message for ts ${event.item.ts}, skipping.`);
    return;
  }

  (async () => {
    try {
      await axios.post(
        `https://api.figma.com/v1/files/${entry.file_key}/comments`,
        { message: '👋 Help is on the way!', comment_id: String(entry.comment_id) },
        { headers: { 'X-Figma-Token': FIGMA_TOKEN, 'Content-Type': 'application/json' } }
      );
      console.log(`[REACTION] Figma reply posted for ${entry.file_key} comment ${entry.comment_id}`);
    } catch (err) {
      console.error('[REACTION] Failed to post Figma reply:', err.response?.data ?? err.message);
    }
  })();
});

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
  const { passcode, event_type, file_key, comment, triggered_by, comment_id } = req.body;
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
        `*Link:* ${deepLink}\n` +
        `_React with 👀 👍 🚀 to notify them help is on the way_`;

      const ts = await postToSlack(slackMessage);
      if (ts && comment_id) {
        messageMap.set(ts, { file_key, comment_id, node_id });
        console.log(`[FILE_COMMENT] Alert sent and mapped ts=${ts} → comment ${comment_id}`);
      } else {
        console.log(`[FILE_COMMENT] Alert sent for ${file_key} — ${alertType}`);
      }
    } else {
      console.log(`[FILE_COMMENT] No trigger keyword in comment for ${file_key}, skipping.`);
    }
  } else if (event_type === 'FILE_UPDATE') {
    console.log(`[FILE_UPDATE] Received for ${file_key}`);
  } else {
    console.log(`[WEBHOOK] Ignored event type: ${event_type}`);
  }

  res.sendStatus(200);
});


const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Figma Triage Bot listening on port ${port}`);
});
