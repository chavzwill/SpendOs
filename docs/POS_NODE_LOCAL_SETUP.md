# Total Tools POS + SpendOS local setup without Docker

Use this path for local development, integration work, previews and handoff verification when Docker is not installed. Docker is optional for this path.

## Fastest path

Requirements:
- Node.js 24 or newer;
- a SpendOS checkout;
- a Total Tools POS checkout that contains `scripts/deliver-spendos-outbox.js`;
- POS dependencies already installed.

From the SpendOS repository:

```powershell
npm run start:linked-pos -- --pos-dir "C:\path\to\pos_system"
```

The launcher:
- starts SpendOS on `127.0.0.1:4010`;
- starts the POS on `127.0.0.1:33172`;
- uses a dedicated `spendos-linked-pos.db` instead of the checkout's normal POS database unless `--pos-db-url` is supplied;
- secures the administrator on the first boot of that isolated database and prints one-time local sign-in credentials;
- generates a strong shared SpendOS server key in memory;
- injects the same tenant, ingest URL and key into both child processes;
- runs the real POS outbox worker once as a startup check;
- performs an authenticated SpendOS status check;
- never prints or persists the generated SpendOS server key.

Press Ctrl+C to stop both services.

## Why this exists

The previous local validation package described Docker Compose first. That made Docker look mandatory even though both applications run directly on Node.

For local integration, the required connection is simply:

```text
POS server
  -> SPENDOS_INGEST_URL=http://127.0.0.1:4010/v1/events
  -> Authorization: Bearer <same server key>
  -> SpendOS receiver
```

A Docker runtime is still useful for container/deployment qualification, but it is not required to connect the POS to SpendOS on one development machine.

## Persistent local configuration

SpendOS now loads an optional repository-root `.env` automatically when started with `npm start`.

Example SpendOS `.env`:

```env
NODE_ENV=development
PORT=4010
SPENDOS_TENANT_ID=total-tools
SPENDOS_API_KEY=<strong-shared-server-key>
SPENDOS_DB=./spendos.db
```
Example POS `.env` additions:

```env
SPENDOS_TENANT_ID=total-tools
SPENDOS_INGEST_URL=http://127.0.0.1:4010/v1/events
SPENDOS_API_KEY=<same-strong-shared-server-key>
SPENDOS_OUTBOX_BATCH=25
SPENDOS_OUTBOX_MAX_ATTEMPTS=8
```

Then run SpendOS and POS in separate terminals with their normal `npm start` commands. The browser never receives `SPENDOS_API_KEY`.

## Verify the link

With both services running, execute from the POS checkout:

```powershell
node scripts/deliver-spendos-outbox.js
```

A healthy empty queue returns a JSON result with `processed: 0`. Existing queued events may instead be delivered. Do not point a test worker at operational data unless that transmission is intentional.

SpendOS health is available at:

```text
GET http://127.0.0.1:4010/health
```

Authenticated management status is:

```text
GET /v1/system/status?tenantId=total-tools
Authorization: Bearer <server key>
```

## First-boot POS credentials

For the launcher's default isolated local database, first boot automatically runs the POS credential hardening preflight with generated one-time local credentials. The terminal prints the local administrator username, temporary password and temporary PIN so the operator can sign in. Change the temporary password through the POS after login.

If `--pos-db-url` or an existing `TURSO_DATABASE_URL` is supplied, the launcher does not alter that database's credentials.

This bootstrap is a POS security control, not a SpendOS dependency. Do not weaken the production preflight or restore legacy demo credentials.

## Production

Do not carry the launcher's ephemeral key into production. Production requires:
- a persistent securely provisioned server-to-server key;
- TLS or equivalent protected ingress;
- management UI credentials and a 32+ character SpendOS session secret;
- controlled outbox scheduling with monitoring/dead-letter handling;
- backup/restore procedures;
- the remaining checks in `KNOWN_DEPLOYMENT_PREREQUISITES.md`.

The POS remains authoritative for operational and financial state. SpendOS remains analytical/advisory.
