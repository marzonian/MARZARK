# Heartbeat

## Status
- Enabled: true
- Schedule (cron): `*/10 * * * *` (every 10 minutes)
- Runner: GitHub Actions (persistent recurring workflow)
- Max commit scan window: `heartbeat.max_commits_scan` (default: 20)
- No-change reporting: `heartbeat.report_on_no_change` (default: false)

## Recurring Task Logic
Every 10 minutes, run this sequence:

1. Pull latest repository state and validate workspace integrity.
2. Read tracked memory files (at minimum `heartbeat.md`, `config.json`, and `skills/**` metadata).
3. Detect meaningful changes since the previous run:
   - config drift
   - skill additions or edits
   - failed or partial runs in recent logs
4. Generate a short status summary:
   - what changed
   - what failed
   - what is recommended next
5. Apply safe self-optimizations when low risk:
   - tighten polling windows
   - skip unchanged paths
   - reduce redundant model calls
6. Write/update heartbeat report artifacts only when tracked memory changes are detected.
7. If any memory file was modified by heartbeat logic, commit and push changes back to the repository.

## External API Policy
- Do not call external APIs unless a required secret is present.
- Default reasoning provider is local Ollama.
- Approved secret allowlist is controlled by `policy.allowed_secrets`.

## Manual Trigger Controls
- `workflow_dispatch` supports:
  - `dry_run` (skip commit/push)
  - `commit_changes`
  - `push_changes`

## Report Artifacts
- `.heartbeat/latest-report.md`
- `.heartbeat/latest-report.json`
- `.heartbeat/state.json` (fingerprint-based change detection)

## Performance Rules
- Prefer incremental diff-based analysis over full scans.
- Skip report rewrites when memory fingerprint is unchanged.
- Cap per-run model calls and bail out early on no-change runs.
- Keep summaries compact to reduce token and latency overhead.
