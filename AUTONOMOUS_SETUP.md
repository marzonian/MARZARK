# Autonomous Business Setup

This repository now contains a fully scheduled autonomous business runner:

- Workflow: `.github/workflows/autonomous-business.yml`
- Script: `scripts/autonomous-business.js`
- Config: `autonomous.config.json`
- Output: `.autonomous/latest-report.md`, `.autonomous/latest-report.json`, `.autonomous/state.json`

## What It Does

Every 30 minutes it:

1. Loads business/trading config.
2. Applies global policy gating from `config.json`.
3. Pulls market quotes from the configured provider (default: Databento) when API secret is allowlisted and present.
4. Generates signal candidates based on move threshold.
5. Builds a business update report.
6. Sends channel updates to Discord and/or Telegram when corresponding secrets are allowlisted and present.
7. Commits/pushes report updates when enabled.

## Required GitHub Secrets For Full Live Mode (Default Databento)

- `DATABENTO_API_KEY`
- `DISCORD_WEBHOOK_URL` (recommended for updates)
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (optional additional channel)

Without these secrets, the workflow still runs, writes reports, and documents what is missing.

## Manual Run

Use GitHub Actions `workflow_dispatch` inputs:

- `dry_run`: true for safe test mode.
- `commit_changes`: whether to create commit for report files.
- `push_changes`: whether to push commits.

## Local Test

```bash
npm run autonomous:dry
```
