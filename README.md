# SpendOS

Standalone spend intelligence and control platform.

## Current receiver slice
- authenticated `POST /v1/events`
- idempotent duplicate handling
- stale source-version rejection
- same-version conflict detection
- normalized spend facts
- supplier price history
- branch/supplier management rollups

## Local development
```powershell
$env:PORT="4010"
$env:SPENDOS_API_KEY="change-me"
node src/server.js
```

Run qualification:

```powershell
npm run check
```

The Total Tools POS remains source-authoritative. SpendOS is advisory/read-only in this phase.
