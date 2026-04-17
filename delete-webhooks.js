// delete-webhooks.js — run once to delete all registered webhooks
// Usage: node delete-webhooks.js

const axios = require('axios');

const TOKEN = process.env.FIGMA_TOKEN || 'figd_...'; // ← fill in or set FIGMA_TOKEN in .env

const WEBHOOK_IDS = [
  '4280305',
  '4280306',
  '4280317',
  '4280318',
  '4280319',
];

(async () => {
  for (const id of WEBHOOK_IDS) {
    try {
      await axios.delete(`https://api.figma.com/v2/webhooks/${id}`, {
        headers: { 'X-Figma-Token': TOKEN },
      });
      console.log(`Deleted webhook ${id}`);
    } catch (err) {
      const status = err.response?.status;
      const message = err.response?.data?.message ?? err.message;
      console.error(`Failed to delete ${id}: [${status}] ${message}`);
    }
  }
})();
