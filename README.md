# SpendOS

SpendOS is a standalone spend-intelligence and control service that connects to an authoritative POS/ERP without becoming a second accounting or inventory system.

## Handoff status

Prepared for handoff on 2026-09-28.
- Core qualification: `npm run check` passes.
- Automated tests: 36/36 passing.
- Total Tools POS connector certification: 7/7 required gates passing.
- Git working tree is intended to be clean at handoff.
- Production deployments must complete the prerequisites in `docs/KNOWN_DEPLOYMENT_PREREQUISITES.md`.

## What SpendOS does

- accepts versioned, idempotent spend events from a POS;
- normalizes requested, received and consumed spend evidence;
- tracks costs by branch, department, vehicle, equipment, rental asset, building, project and other cost objects;
- tracks supplier price history and identifies savings opportunities;
- evaluates budgets and abnormal consumable usage;
- records savings actions and verifies realized savings from later actual evidence;
- prevents the same receipt evidence from being counted twice;
- tracks savings targets, accountability attention and savings leakage;
- verifies leakage remediation using post-action evidence.

## Authority boundary

The POS remains authoritative for purchasing, inventory, Accounts Payable, supplier payments, recoverables, credit notes, returns, allocations and accounting journals. SpendOS is analytical/advisory and must not directly mutate those ledgers.

Reference flow:

```text
POS business transaction
  -> transactional outbox event
  -> SpendOS POST /v1/events
  -> normalized spend evidence
  -> savings / cost / budget analytics
  -> advisory management APIs
  -> any financial action returns through the POS workflow
```

## Standalone management UI

SpendOS includes a responsive Total Tools management control center served from `/`. It uses the real SpendOS database and API for spend, supplier, cost-object, savings, target and leakage views. There is no demo seeder or synthetic dashboard dataset in the operational application.

The UI reports its POS evidence state from accepted SpendOS events:
- `connected` when recent POS evidence has been received;
- `stale` when the latest accepted event is more than 24 hours old;
- `waiting_for_evidence` when no real POS spend events have arrived yet.

Opening the dashboard is read-only. Savings analysis runs only when a user intentionally selects **Run savings scan**.

## Requirements

- Node.js 24 or newer
- SQLite through Node's built-in `node:sqlite`
- no third-party runtime dependencies

## Quick start

```powershell
Copy-Item .env.example .env
# Edit .env, then:
npm start
```

`npm start` automatically loads the repository-root `.env` when it exists. The service binds to `127.0.0.1` by default. Put it behind an authenticated TLS reverse proxy or equivalent production ingress.

For a Docker-free Total Tools POS integration on one development machine:

```powershell
npm run start:linked-pos -- --pos-dir "C:\path\to\pos_system"
```

See `docs/POS_NODE_LOCAL_SETUP.md` for the exact local-link behavior and production boundary.

### Authentication

SpendOS separates machine and human credentials:
- `SPENDOS_API_KEY` authenticates POS/server-to-server event delivery and must never be exposed to the browser.
- `SPENDOS_UI_USER` and `SPENDOS_UI_PASSWORD` authenticate the management UI.
- `SPENDOS_SESSION_SECRET` signs the HttpOnly, SameSite management session cookie.

When `NODE_ENV=production`, the API key, UI password and a session secret of at least 32 characters are mandatory. In local development, the loopback UI may run in open-local mode when UI credentials are intentionally omitted.

## Qualification

```powershell
npm run check
```

This performs syntax qualification and the full automated test suite.

## API overview

Core route families include:
- `POST /v1/events`
- `GET /v1/system/status`
- `GET /v1/management/dashboard`
- `GET /v1/savings/opportunities`
- `GET /v1/budgets/status`
- `GET /v1/suppliers/prices`
- `GET /v1/costs/target`
- `GET /v1/costs/portfolio`
- `GET /v1/costs/coverage`
- `GET /v1/costs/trend`
- `POST /v1/budgets`
- `POST /v1/savings/run`
- savings opportunity action/verification endpoints;
- savings target/performance/attention endpoints;
- savings leakage case lifecycle endpoints.

## Handoff documentation

Start here:
- `HANDOFF.md` — takeover sequence, scope and acceptance state.
- `docs/POS_INTEGRATION_GUIDE.md` — full POS integration contract and instructions for a developer or AI agent.
- `docs/POS_NODE_LOCAL_SETUP.md` — Docker-free local Total Tools POS + SpendOS startup and verification.
- `docs/POS_LOCAL_VALIDATION.md` — isolated Total Tools POS connector validation report.
- `docs/certification/` — machine-readable results and complete certification logs.
- `docs/KNOWN_DEPLOYMENT_PREREQUISITES.md` — remaining production installation requirements.
- `integration/total-tools-pos/` — example POS environment and Compose overlay.

## Data safety

Local SQLite files, WAL/SHM files, populated environment files and `node_modules` are ignored by Git. Do not commit production data or credentials.

## Repository scope

This repository contains the SpendOS analytical service/API core. The Total Tools POS repository contains the authoritative operational workflows, transactional outbox, employee permissions and POS-facing management proxy/UI integration.

See `HANDOFF.md` before changing authority boundaries or declaring a deployment live.
