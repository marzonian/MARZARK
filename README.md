# MARZARK Autonomous Stack

This repository runs two independent autonomous loops:

1. Heartbeat loop (`.github/workflows/heartbeat.yml`) every 10 minutes.
2. Business loop (`.github/workflows/autonomous-business.yml`) every 30 minutes.

## Business Loop Outputs

- `.autonomous/latest-report.md`
- `.autonomous/latest-report.json`
- `.autonomous/state.json`

## Required Secrets For Live Updates

Add these in `GitHub -> Settings -> Secrets and variables -> Actions`:

- `FMP_API_KEY` (market quote feed)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Without secrets, the business loop still runs and generates report files with missing-secret diagnostics.

## Local Commands

```bash
npm run heartbeat:dry
npm run autonomous:dry
```
