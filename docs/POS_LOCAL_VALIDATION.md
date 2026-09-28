# SpendOS local validation and setup package

Prepared 2026-09-28 from the clean POS worktree `C:\Users\Chavez.Williams\Downloads\pos_system-worktrees\spendos-connector`, branch `docs/spendos-pos-integration`, commit `fd0b647c`.

The source worktree was inspected without modification. Certification ran in a disposable copy under `../spendos-verification`, using its own test databases and the source checkout's installed dependencies. Neither the existing POS database nor the courier worktree was used for these checks. No live SpendOS endpoint was contacted, credentials configured, backfill applied to operational data, worker scheduled or application deployed.

## Verification result

All seven commands required by the integration guide exited successfully:

| Check | Result |
| --- | --- |
| `npm run check:spendos-connector` | PASS |
| `npm run check:spendos-backfill` | PASS |
| `npm run check:spendos-business-journey` | PASS |
| `npm run check:spendos-guide-me` | PASS |
| `npm run check:guided-mode` | PASS |
| `node scripts/check-accounting-financial-integrity-certification.js` | PASS |
| `node scripts/check-client-syntax.js` | PASS |

Node 24.19.0 was used. The connector runtime tests use local HTTP fixtures; these results establish local behavior, not interoperability with a deployed SpendOS service. Machine-readable results and complete logs are in `evidence/`.

Docker was not available on this host. Container build, Compose rendering, production preflights and Docker's Node 22 runtime were **not tested**. The supplied override remains a setup template, not a certified deployed configuration.

Follow-up on 2026-09-28: the Docker-free launcher in `scripts/start-total-tools-pos-local.js` was exercised against the same POS connector worktree with a disposable SQLite database. SpendOS and POS both started, the real POS outbox worker completed successfully with an empty queue, and the launcher completed an authenticated SpendOS status check. Docker is therefore **not required** for same-machine development/integration setup.

## Files supplied

- `compose.spendos.local.yml`: passes the missing SpendOS environment variables into the POS container, binds its HTTP port to loopback only and separates local data/uploads from normal deployment directories.
- `spendos.env.example`: empty endpoint/key placeholders and example tenant/batch settings. Contains no credentials.
- `evidence/`: actual local check results and logs.

## Local installation procedure

Use a separate non-production POS checkout and database. Do not point setup verification at operational data.

### Recommended: Node-native local link

Docker is not required. From the SpendOS repository run:

```powershell
npm run start:linked-pos -- --pos-dir "C:\path\to\pos_system"
```

The launcher starts SpendOS on `127.0.0.1:4010` and the POS on `127.0.0.1:33172`, generates a shared server key in memory, injects the matching tenant/ingest settings, runs the real POS outbox worker once, and performs an authenticated SpendOS status check. See `POS_NODE_LOCAL_SETUP.md`.

For persistent local configuration, place the shared `SPENDOS_TENANT_ID`, `SPENDOS_INGEST_URL` and `SPENDOS_API_KEY` in the POS environment and the matching tenant/key in the SpendOS `.env`. `npm start` now loads the SpendOS `.env` automatically.

After both services are running, authenticate through POS and inspect `GET /api/spendos-management/outbox/health` using an authorized staff session. Browser clients must call POS and must never receive the SpendOS server key.

For a disposable POS dataset, inspect backfill before applying it:

```powershell
node scripts/backfill-spendos-purchase-requests.js
```

Review unsafe or missing-allocation records. `--apply` is a separate write action.

Execute a single delivery batch only after confirming the destination:

```powershell
node scripts/deliver-spendos-outbox.js
```

### Optional: Docker/Compose qualification

Use `compose.spendos.local.yml` and `spendos.env.example` only when container behavior itself needs qualification. A fresh production-mode POS database may require `POS_BOOTSTRAP_ADMIN_USER`, `POS_BOOTSTRAP_ADMIN_PASSWORD` and `POS_BOOTSTRAP_ADMIN_PIN`; that is a POS security preflight, not a SpendOS dependency.

When Docker is used, remember that `localhost` inside the POS container is the container itself. Point `SPENDOS_INGEST_URL` at a hostname reachable from the container.

## Findings to resolve before live installation

- Base `docker-compose.yml` does not inject the guide's `SPENDOS_*` variables. The supplied override addresses configuration delivery; a host `.env` alone is insufficient for these container variables.
- The worker and management proxy accept an absent bearer key. Production configuration must require authentication; the supplied override requires a nonempty key.
- Worker/proxy fetch calls have no explicit application timeout. The worker uses a two-minute lease but has no lease-owner token guarding completion updates. A slow request can outlive its lease. Receiver deduplication remains mandatory; overlapping workers and timeout/reconciliation behavior need further qualification before live scheduling.
- Receiver tenant authorization, immutable-event deduplication and the full expected management API have not been tested against a real SpendOS service.
- Deployment-host preflights, persistent secret provisioning, backups, scheduler and operator permissions remain production prerequisites. Docker-specific preflights apply only when the chosen production topology uses containers.

POS remains authoritative for all financial and operational decisions. SpendOS supplies analytics/advice and must not directly mutate POS stock, AP, payments or journals.
