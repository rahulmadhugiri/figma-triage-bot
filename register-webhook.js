// register-webhook.js — run once locally to register Figma webhooks
// Usage: node register-webhook.js
// Fill in the four constants below, then run.

const axios = require('axios');

const FILE_IDS = ['abc123', 'def456']; // ← fill in your Figma file keys
const TOKEN = 'figd_...';              // ← your Figma Personal Access Token
const ENDPOINT = 'https://your-server.onrender.com/webhook'; // ← your deployed URL
const PASSCODE = 'FigmaBot'; // ← must match FIGMA_PASSCODE in .env

const EVENT_TYPES = ['FILE_COMMENT', 'FILE_UPDATE'];

async function registerWebhook(file_id, event_type) {
  const url = 'https://api.figma.com/v2/webhooks';
  // Fix 3: V2 uses context/context_id, not file_key
  const body = { event_type, context: 'file', context_id: file_id, endpoint: ENDPOINT, passcode: PASSCODE };

  try {
    const { data } = await axios.post(url, body, {
      headers: { 'X-Figma-Token': TOKEN, 'Content-Type': 'application/json' },
    });
    console.log(`Registered ${event_type} for ${file_id} → webhook ID: ${data.id}`);
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message ?? err.message;
    console.error(`Failed to register ${event_type} for ${file_id}: [${status}] ${message}`);
  }
}

(async () => {
  for (const file_id of FILE_IDS) {
    for (const event_type of EVENT_TYPES) {
      await registerWebhook(file_id, event_type);
    }
  }
})();
