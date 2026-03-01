# MARZARK Autonomous Stack

This repository runs two independent autonomous loops:

1. Heartbeat loop (`.github/workflows/heartbeat.yml`) every 10 minutes.
2. Business loop (`.github/workflows/autonomous-business.yml`) every 30 minutes.

## Business Loop Outputs

- `.autonomous/latest-report.md`
- `.autonomous/latest-report.json`
- `.autonomous/daily-premium.md`
- `.autonomous/daily-premium.json`
- `.autonomous/weekly-summary.md`
- `.autonomous/weekly-summary.json`
- `.autonomous/state.json`

## Risk Filters And Premium Windows

`autonomous.config.json` now supports:

- `trading.risk_filters.max_alerts_per_cycle`
- `trading.risk_filters.max_abs_move_pct`
- `trading.risk_filters.min_volume`
- `trading.risk_filters.max_quote_age_minutes`
- `trading.risk_filters.symbol_cooldown_minutes`
- `premium_reports.write_on_no_change`
- `premium_reports.history_max_entries`

## Required Secrets For Live Updates

Add these in `GitHub -> Settings -> Secrets and variables -> Actions`:

- `DATABENTO_API_KEY` (market quote feed)
- `DISCORD_WEBHOOK_URL` (recommended update channel)
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (optional secondary channel)

Without secrets, the business loop still runs and generates report files with missing-secret diagnostics.

## Local Commands

```bash
npm run heartbeat:dry
npm run autonomous:dry
```
