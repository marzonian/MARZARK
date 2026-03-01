# repo-memory-summary

Node.js skill for GitHub Runner jobs. It emits a JSON summary of tracked memory state by reading:

- `config.json` tracked paths
- latest tracked commits in git
- `.heartbeat/latest-report.json` (if available)

## Run

```bash
node skills/repo-memory-summary/index.js
```
