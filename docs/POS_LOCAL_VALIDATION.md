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

Docker was not available on this host. Container build, Compose rendering, production preflights and Docker's Node 22 runtime were **not tested**. The supplied override is a setup template, not a certified deployed configuration.

## Files supplied

- `compose.spendos.local.yml`: passes the missing SpendOS environment variables into the POS container, binds its HTTP port to loopback only and separates local data/uploads from normal deployment directories.
- `spendos.env.example`: empty endpoint/key placeholders and example tenant/batch settings. Contains no credentials.
- `evidence/`: actual local check results and logs.

## Local installation procedure

Use a separate POS checkout at the reviewed commit. Copy the two configuration templates there. Do not use the courier worktree or point this exercise at an operational database.

1. Install Docker Engine/Desktop with Compose, and follow the repository's production credential/settings-secret setup instructions. The existing entrypoint performs these preflights even for this local container. On first boot of the new local database, provision `POS_BOOTSTRAP_ADMIN_USER`, `POS_BOOTSTRAP_ADMIN_PASSWORD` (12+ characters with upper/lowercase, digit and symbol) and `POS_BOOTSTRAP_ADMIN_PIN` (6–10 digits, not repeated/common/sequential). The override passes these into the container. After successful bootstrap, remove the password/PIN from the environment and recreate the container. The legacy README's default-admin paragraph is not evidence that current preflights permit that password; do not reset a database to obtain it.
2. Before creating secrets, add `.env.spendos.local`, `data-spendos-local/` and `uploads-spendos-local/` to that checkout's Git exclusion rules. Copy `spendos.env.example` to `.env.spendos.local`. Set an actual SpendOS ingest URL, matching tenant ID, server-only API key and a valid POS settings-encryption key. Keep the file untracked and access restricted. `localhost` inside a container names the container, not a service running on the host; use a reachable service hostname.
3. From that checkout, render/validate the composition without printing secret values:

   ```sh
   docker compose --env-file .env.spendos.local -f docker-compose.yml -f compose.spendos.local.yml config --quiet
   ```

4. Once local credentials/preflights and the intended service are configured, build/start the local installation:

   ```sh
   docker compose --env-file .env.spendos.local -f docker-compose.yml -f compose.spendos.local.yml up -d --build
   ```

   The POS is bound to `http://127.0.0.1:33172`; its SQLite data lives in `data-spendos-local/` and uploads in `uploads-spendos-local/`. This command is documented, not executed by this task.

5. Authenticate through POS and inspect `GET /api/spendos-management/outbox/health` using an authorized staff session. Browser clients must call POS, never receive the SpendOS server key.
6. For a disposable dataset, inspect the backfill before deciding to apply it:

   ```sh
   docker compose --env-file .env.spendos.local -f docker-compose.yml -f compose.spendos.local.yml exec -T --user app app node --require ./lib/local-sqlite-runtime.js scripts/backfill-spendos-purchase-requests.js
   ```

   Review unsafe/missing-allocation records. `--apply` is a separate write action and was not executed against existing data here.
7. After creating intentional local evidence and confirming the destination, execute a single worker batch:

   ```sh
   docker compose --env-file .env.spendos.local -f docker-compose.yml -f compose.spendos.local.yml exec -T --user app app node --require ./lib/local-sqlite-runtime.js scripts/deliver-spendos-outbox.js
   ```

   This transmits queued evidence to the configured SpendOS service. No scheduler is installed by this package. Use the same Compose/env selection for every later command, and serialize scheduled worker executions.

## Findings to resolve before live installation

- Base `docker-compose.yml` does not inject the guide's `SPENDOS_*` variables. The supplied override addresses configuration delivery; a host `.env` alone is insufficient for these container variables.
- The worker and management proxy accept an absent bearer key. Production configuration must require authentication; the supplied override requires a nonempty key.
- Worker/proxy fetch calls have no explicit application timeout. The worker uses a two-minute lease but has no lease-owner token guarding completion updates. A slow request can outlive its lease. Receiver deduplication remains mandatory; overlapping workers and timeout/reconciliation behavior need further qualification before live scheduling.
- Receiver tenant authorization, immutable-event deduplication and the full expected management API have not been tested against a real SpendOS service.
- Docker preflights, secrets provisioning, backups, scheduler and operator permissions remain installation prerequisites. This package does not claim production readiness merely because the local guide checks pass.

POS remains authoritative for all financial and operational decisions. SpendOS supplies analytics/advice and must not directly mutate POS stock, AP, payments or journals.
