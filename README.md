# Figma Triage Bot

A lightweight background service built for live design workshops. When participants hit tool errors or get stuck, they drop a tagged comment in Figma — the bot picks it up and routes an alert to a dedicated Slack channel instantly, so a tech support person can unblock teams without interrupting the session.

No UI. No Figma plugin. Pure Node.js webhook receiver → Slack alerts.

---

## How It Works

### The Full Loop

1. A participant is stuck during a live workshop and types a comment in Figma — e.g. `"auto-layout is broken #tech"` or `"I don't know what step we're on #coach"`
2. Figma fires a webhook to your server (hosted on Render)
3. The server checks the comment for trigger keywords
4. Within seconds, a formatted alert appears in your Slack channel with the user's name, their comment, and a direct deep link to the exact frame in Figma
5. The tech support person reacts to the Slack alert with 👀 👍 or 🚀
6. The bot automatically posts `"👋 Help is on the way!"` as a threaded reply on the original Figma comment — notifying the participant instantly
7. The issue gets resolved — **without Heather ever pausing the lesson**

### Trigger Keywords

| Keyword | Slack Alert |
|---|---|
| `#tech` or `#bug` | `[🚨 TECH ISSUE]` |
| `#coach` or `#stuck` | `[🙋 COACH HELP]` |
| anything else | no alert fired |

### Reaction-to-Figma Reply

When a support person reacts to a triage alert in Slack with 👀, 👍, or 🚀, the bot posts `"👋 Help is on the way!"` as a threaded reply directly on the participant's Figma comment. This closes the loop — the participant gets a Figma notification without anyone needing to manually switch context.

### Adding New Files via Slack

Instead of editing code, register a new Figma file directly from Slack:

```
/add-file https://www.figma.com/board/ggs5L02F7m9xvWfJhVHDcg/My-File
```

The bot extracts the file key, registers both `FILE_COMMENT` and `FILE_UPDATE` webhooks with Figma, and confirms in the channel with the new webhook IDs.

---

## Architecture

```
Figma comment (#tech / #coach)
    │
    ▼
Figma Webhooks API
    │  POST /webhook  (passcode in body)
    ▼
Express Server (Render)
    ├── Passcode check → 401 if wrong
    ├── PING → 200 OK (webhook registration handshake)
    └── FILE_COMMENT → keyword check → chat.postMessage → store ts+comment_id
    │
    ▼
Slack #workshop-triage (via Bot Token)
    │
    │  Support person reacts with 👀 / 👍 / 🚀
    ▼
Slack Events API
    │  POST /slack/events
    ▼
Express Server (Render)
    └── Look up ts in messageMap → POST /v1/files/{key}/comments (threaded reply)
    │
    ▼
Figma — "👋 Help is on the way!" reply on participant's comment

Slack /add-file command
    │  POST /slack/commands
    ▼
Express Server (Render)
    └── Verify Slack signature → extract file key → register Figma webhooks
    │
    ▼
Slack confirmation (webhook IDs posted in channel)
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `FIGMA_PASSCODE` | Secret string included in every webhook payload — rejects requests that don't match |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL (fallback if bot token not set) |
| `SLACK_BOT_TOKEN` | `xoxb-` Bot Token — used for `chat.postMessage` so message `ts` can be stored for reaction mapping |
| `SLACK_CHANNEL_ID` | Channel ID of `#workshop-triage` (right-click channel → View channel details → bottom of About tab) |
| `SLACK_SIGNING_SECRET` | From Slack App → Basic Information → App Credentials — verifies slash command and event requests |
| `FIGMA_TOKEN` | Figma PAT with `webhooks:read`, `webhooks:write`, `file_comments:write` scopes. Set to no expiration. |
| `RENDER_URL` | Your server's public URL — used as the webhook endpoint when registering new files |
| `PORT` | (Optional) defaults to `3000`. Render sets this automatically. |

---

## File Structure

```
figma-triage-bot/
├── index.js              # Express server — all webhook, Slack, and reaction logic
├── register-webhook.js   # One-shot script to register Figma webhooks from the terminal
├── delete-webhooks.js    # One-shot script to delete webhooks by ID
├── package.json
├── .env                  # Your actual secrets — never commit this
├── .env.example          # Template for .env
├── .gitignore
└── README.md
```

---

## Setup & Deployment

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in all values in `.env` (see Environment Variables table above).

### 3. Deploy to Render
- Create a new **Web Service** → connect your GitHub repo
- Start Command: `node index.js`
- Add all environment variables in the Render dashboard
- Copy your live Render URL

### 4. Create a Slack App
- Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
- **OAuth & Permissions** → Bot Token Scopes → add `chat:write`, `reactions:read`
- **Slash Commands** → Create New Command:
  - Command: `/add-file`
  - Request URL: `https://figma-triage-bot.onrender.com/slack/commands`
- **Event Subscriptions** → Enable → Request URL: `https://figma-triage-bot.onrender.com/slack/events` → Subscribe to bot event: `reaction_added`
- **Install App** → Install to Workspace → Allow
- Copy **Signing Secret** from Basic Information → App Credentials
- In `#workshop-triage`, type `/invite @your-bot-name` so the bot can post

### 5. Figma Personal Access Token
Figma → Help and Account → Account Settings → Personal Access Tokens → Generate new token.

Required scopes: `webhooks:read`, `webhooks:write`, `file_comments:write`

Set expiration to **No expiration** — the bot breaks the moment the token expires.

### 6. Register Figma webhooks (first time only)
Fill in `register-webhook.js` and run:
```bash
node register-webhook.js
```
After initial setup, use `/add-file` in Slack for all new files.

---

## Adding Files Going Forward

```
/add-file https://www.figma.com/board/ggs5L02F7m9xvWfJhVHDcg/My-File
```

Works with `/file/`, `/board/`, and `/design/` Figma URLs.

> **Note:** Render free tier spins down after inactivity. If `/add-file` times out, visit `https://figma-triage-bot.onrender.com/health` to wake the server, then try again.

---

## Deleting Webhooks

```bash
node delete-webhooks.js
```

Add the webhook IDs to the `WEBHOOK_IDS` array at the top of the file before running.

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Receives Figma webhook events (FILE_COMMENT, FILE_UPDATE, PING) |
| `/slack/commands` | POST | Handles `/add-file` slash command |
| `/slack/events` | POST | Handles Slack reaction events → posts Figma reply |
| `/health` | GET | Health check — returns `200 OK` |

---

## Testing

```bash
npm start

# 401 — wrong passcode
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"wrong","event_type":"FILE_COMMENT","file_key":"abc123"}'

# [🚨 TECH ISSUE] alert in Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"FILE_COMMENT","file_key":"abc123","comment_id":"999","comment":[{"text":"plugin is broken #tech"}],"triggered_by":{"handle":"alice"}}'

# [🙋 COACH HELP] alert in Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"FILE_COMMENT","file_key":"abc123","comment_id":"999","comment":[{"text":"lost on this step #coach"}],"triggered_by":{"handle":"bob"}}'

# PING ack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"PING","file_key":"abc123"}'

# Health check
curl localhost:3000/health
```

---

## Currently Monitored Files

| File | FILE_COMMENT Webhook | FILE_UPDATE Webhook |
|---|---|---|
| Custom Plugin Test Board (`ggs5L02F7m9xvWfJhVHDcg`) | 4280569 | 4280570 |
| Test Team 2 (`MzGYwC9EWLIz5CwlIPHPHV`) | 4280318 | 4280319 |

To add more files: `/add-file <figma-url>` in Slack.

---

## Important Notes

- **Figma webhooks require a Professional or Organization plan.** Files on free/starter teams return `403`. Make sure the file lives under your paid org.
- **Figma PAT must have `file_comments:write`** in addition to webhook scopes, or the reaction-to-reply feature will 403.
- **Set the Figma PAT to no expiration** — the bot silently breaks when it expires.
- **The passcode is in the JSON body** (`req.body.passcode`), not headers. This is Figma V2 webhook behavior.
- **Render free tier spins down after inactivity.** Wake it via `/health` before a workshop, or upgrade to a paid instance for always-on reliability.
- **Slack slash commands have a 3-second timeout.** `/add-file` acknowledges immediately and does API work in the background.
- **Reaction mapping is in-memory.** If the server restarts, reactions on old alerts won't trigger Figma replies. This only matters if Render redeploys mid-session.
