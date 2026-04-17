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
5. The tech support person clicks the link, lands on the exact spot, and fixes it — **without Heather ever pausing the lesson**

### Trigger Keywords

| Keyword | Slack Alert |
|---|---|
| `#tech` or `#bug` | `[🚨 TECH ISSUE]` |
| `#coach` or `#stuck` | `[🙋 COACH HELP]` |
| anything else | no alert fired |

### Inactivity Monitoring

Every 60 seconds, the server checks all tracked files. If a file has had **no edits for 7 minutes**, it fires a `[⚠️ INACTIVITY WARNING]` to Slack. This is the early signal that a team has quietly fallen behind before anyone raises their hand. The warning resets automatically after the next edit.

### Adding New Files via Slack

Instead of editing code, you can register a new Figma file directly from Slack using the `/add-file` slash command:

```
/add-file https://www.figma.com/board/ggs5L02F7m9xvWfJhVHDcg/My-File
```

The bot extracts the file key, registers both `FILE_COMMENT` and `FILE_UPDATE` webhooks with Figma, and confirms in the channel with the new webhook IDs.

---

## Architecture

```
Figma File
    │
    │  (participant leaves a comment or makes an edit)
    │
    ▼
Figma Webhooks API
    │
    │  POST /webhook  (with passcode in body)
    │
    ▼
Express Server (Render)
    │
    ├── Passcode check → 401 if wrong
    ├── PING → 200 OK immediately (required for webhook registration)
    ├── FILE_COMMENT → keyword check → Slack alert
    └── FILE_UPDATE  → reset inactivity timer
    │
    ▼
Slack Incoming Webhook
    │
    ▼
#workshop-triage channel

Slack /add-file command
    │
    │  POST /slack/commands  (Slack signs request with signing secret)
    │
    ▼
Express Server (Render)
    │
    └── Verify Slack signature → extract file key → call Figma API → register webhooks
    │
    ▼
Slack response (webhook IDs confirmed in channel)
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `FIGMA_PASSCODE` | Secret string included in every webhook payload — rejects requests that don't match |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL for your triage channel |
| `SLACK_SIGNING_SECRET` | From your Slack App's Basic Information → App Credentials — used to verify slash command requests |
| `FIGMA_TOKEN` | Figma Personal Access Token — used by `/add-file` to register webhooks at runtime |
| `RENDER_URL` | Your server's public URL (e.g. `https://figma-triage-bot.onrender.com`) — used as the webhook endpoint when registering new files |
| `PORT` | (Optional) HTTP port, defaults to `3000`. Render sets this automatically. |

---

## File Structure

```
figma-triage-bot/
├── index.js              # Express server — webhook receiver, Slack poster, inactivity monitor, /add-file handler
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
Fill in `.env`:
```
FIGMA_PASSCODE=FigmaBot
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_SIGNING_SECRET=...
FIGMA_TOKEN=figd_...
RENDER_URL=https://figma-triage-bot.onrender.com
```

### 3. Deploy to Render
- Create a new **Web Service** on [Render](https://render.com)
- Connect your GitHub repo
- Set the **Start Command** to `node index.js`
- Add all environment variables in the Render dashboard
- Copy your live Render URL

### 4. Create a Slack App for the `/add-file` command
- Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
- Under **Slash Commands** → Create New Command:
  - Command: `/add-file`
  - Request URL: `https://figma-triage-bot.onrender.com/slack/commands`
  - Description: `Register a Figma file for triage monitoring`
- Under **Settings → Install App** → Install to Workspace → Allow
- Copy the **Signing Secret** from Settings → Basic Information → App Credentials
- Add `SLACK_SIGNING_SECRET` to your Render environment variables

### 5. Register Figma webhooks (terminal — first time only)
Open `register-webhook.js` and fill in the constants at the top:

```js
const FILE_IDS = ['abc123', 'def456']; // Figma file keys
const TOKEN    = 'figd_...';           // Figma Personal Access Token
const ENDPOINT = 'https://figma-triage-bot.onrender.com/webhook';
const PASSCODE = 'FigmaBot';
```

**How to find a file key:** The key is the string between `/file/` or `/board/` and the next `/` in the Figma URL:
```
https://www.figma.com/board/ggs5L02F7m9xvWfJhVHDcg/My-File
                             ^^^^^^^^^^^^^^^^^^^^^^
                             this is the file key
```

**How to get a Personal Access Token:** Figma → top-left menu → Help and Account → Account Settings → Personal Access Tokens → Generate new token. Only `webhooks:read` and `webhooks:write` scopes are needed.

Then run:
```bash
node register-webhook.js
```

After the initial setup, use `/add-file` in Slack instead of editing this file.

---

## Adding Files Going Forward

Just paste the Figma URL into Slack:

```
/add-file https://www.figma.com/board/ggs5L02F7m9xvWfJhVHDcg/My-File
```

The bot will respond with the new webhook IDs confirming it's live. Works with `/file/`, `/board/`, and `/design/` Figma URLs.

> **Note:** Render free tier spins down after inactivity. If `/add-file` fails with "app did not respond", visit `https://figma-triage-bot.onrender.com/health` in your browser first to wake the server up, then try again.

---

## Deleting Webhooks

If you need to clean up or start fresh, add the webhook IDs to `delete-webhooks.js` and run:

```bash
node delete-webhooks.js
```

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Receives all Figma webhook events |
| `/slack/commands` | POST | Handles the `/add-file` Slack slash command |
| `/health` | GET | Health check — returns `200 OK` |

---

## Testing

```bash
# Start the server locally
npm start

# Should return 401 — wrong passcode
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"wrong","event_type":"FILE_COMMENT","file_key":"abc123"}'

# Should fire [🚨 TECH ISSUE] in Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"FILE_COMMENT","file_key":"abc123","comment":[{"text":"plugin is broken #tech","node_id":"123:456"}],"triggered_by":{"handle":"alice"}}'

# Should fire [🙋 COACH HELP] in Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"FILE_COMMENT","file_key":"abc123","comment":[{"text":"lost on this step #coach"}],"triggered_by":{"handle":"bob"}}'

# Should record timestamp (wait 7+ min for inactivity warning)
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"FigmaBot","event_type":"FILE_UPDATE","file_key":"abc123"}'

# Should return 200 OK — PING ack
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
| Custom Plugin Test Board (`ggs5L02F7m9xvWfJhVHDcg`) | 4280317 | 4280306 |
| Test Team 2 (`MzGYwC9EWLIz5CwlIPHPHV`) | 4280318 | 4280319 |

To add more files going forward, use `/add-file <figma-url>` in Slack.

---

## Important Notes

- **Figma webhooks require a Professional or Organization plan.** Files on free/starter teams will return a `403 Upgrade to professional team` error. Make sure the file lives in a team under your paid org.
- **The passcode is sent in the JSON body** (`req.body.passcode`), not in headers. This is Figma V2 webhook behavior.
- **Node IDs contain colons** (e.g. `123:456`) and are URL-encoded in deep links so Slack renders them correctly.
- **Render free tier spins down after inactivity.** The first request after a cold start may be delayed 30-50 seconds. Wake the server by visiting `/health` before a workshop. Upgrade to a paid Render instance for always-on reliability.
- **Slack slash commands have a 3-second timeout.** The `/add-file` endpoint responds immediately and does the Figma API work in the background, posting the result via Slack's `response_url`.
