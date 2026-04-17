# Figma Triage Bot

Background service for live design workshops. Listens for Figma webhook events and routes alerts to a dedicated Slack channel so a tech support person can unblock teams without interrupting the session.

## How it works

- `#tech` or `#bug` in a Figma comment → `[🚨 TECH ISSUE]` Slack alert
- `#coach` or `#stuck` in a Figma comment → `[🙋 COACH HELP]` Slack alert
- No edits to a file for 7 minutes → `[⚠️ INACTIVITY WARNING]` Slack alert

## Environment Variables

| Variable | Description |
|---|---|
| `FIGMA_PASSCODE` | Secret string sent in `x-figma-passcode` header by Figma |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |
| `PORT` | (Optional) HTTP port, defaults to `3000` |

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your values
3. Deploy to Render/Heroku; copy the public URL
4. In `register-webhook.js`, fill in `FILE_IDS`, `TOKEN`, `ENDPOINT`, and `PASSCODE`
5. Run `node register-webhook.js` once locally
6. Post a comment with `#tech` in any registered Figma file and verify the Slack alert fires

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Receives Figma webhook events |
| `/health` | GET | Health check (returns 200 OK) |

## Verification

```bash
# Should return 401
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-figma-passcode: wrong' \
  -d '{}'

# Should send [🚨 TECH ISSUE] to Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-figma-passcode: your-secret-passcode' \
  -d '{"event_type":"FILE_COMMENT","file_key":"abc123","comment":[{"text":"#tech screen is broken"}],"triggered_by":{"handle":"alice"}}'

# Should send [🙋 COACH HELP] to Slack
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-figma-passcode: your-secret-passcode' \
  -d '{"event_type":"FILE_COMMENT","file_key":"abc123","comment":[{"text":"#coach need help with auto layout"}],"triggered_by":{"handle":"bob"}}'

# Should record timestamp (then wait 7+ min for inactivity warning)
curl -X POST localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-figma-passcode: your-secret-passcode' \
  -d '{"event_type":"FILE_UPDATE","file_key":"abc123"}'
```

## File Structure

```
figma-triage-bot/
├── index.js              # Express server + webhook handler
├── register-webhook.js   # One-shot webhook registration script
├── package.json
├── .env.example
├── .gitignore
└── README.md
```
