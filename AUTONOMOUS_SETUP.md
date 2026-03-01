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
3. Pulls market quotes if `FMP_API_KEY` is both allowlisted and present.
4. Generates signal candidates based on move threshold.
5. Builds a business update report.
6. Sends Telegram updates if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are allowlisted and present.
7. Commits/pushes report updates when enabled.

## Required GitHub Secrets For Full Live Mode

- `FMP_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

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
