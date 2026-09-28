# SpendOS Handoff

Prepared: 2026-09-28

This file is the starting point for the next developer or AI agent.

## Current delivery state

The SpendOS analytical service and standalone management control-center UI are implemented and locally qualified. At handoff:
- the responsive UI is served from `/` and reads from the real SpendOS APIs;
- `npm run check` passes;
- 29 core tests pass with zero failures;
- the Total Tools POS SpendOS connector has 7/7 required local certification gates passing;
- certification logs are committed under `docs/certification/`;
- the POS integration contract is committed under `docs/POS_INTEGRATION_GUIDE.md`;
- no real production credentials or operational databases belong in this repository.

The handoff is a code and integration handoff. It is not evidence that a live production deployment has already been completed.

## First commands

```powershell
git status
node --version
npm run check
```

Use Node.js 24+.

## System boundary

Do not turn SpendOS into a second POS, AP ledger, inventory ledger or accounting ledger.

The POS owns:
- purchasing approvals and purchase orders;
- inventory and internal consumption;
- supplier invoices, AP and payments;
- supplier returns, credit notes and recoverables;
- accounting journals and settlement;
- staff identity, RBAC and operational approvals.

SpendOS owns:
- ingested analytical evidence;
- spend/cost analytics;
- savings opportunities;
- savings actions and verification records;
- savings targets and accountability attention;
- savings leakage cases and analytical status.

A SpendOS recommendation must re-enter the POS through its normal permissioned workflow before it can change financial or operational state.

## Handoff inventory

`src/`
: SpendOS receiver, storage, normalization, analytics, budgets, cost economics and savings lifecycle.

`tests/`
: deterministic receiver and savings qualification.

`docs/POS_INTEGRATION_GUIDE.md`
: authoritative integration instructions for another POS developer or AI.

`docs/POS_LOCAL_VALIDATION.md`
: exact scope and limitations of the Total Tools POS connector validation.

`docs/certification/`
: seven passing connector/integrity qualification logs plus machine-readable results.

`integration/total-tools-pos/`
: example environment template and Compose override for an isolated Total Tools POS integration.

`.env.example`
: SpendOS service environment template with no credentials.

## Verified behavior

The current automated suite covers idempotent replay, stale-write rejection, same-version conflict detection, spend normalization, supplier pricing, cost allocations, actual-vs-requested costs, budget assessment, consumable variance, savings verification, evidence de-duplication, savings targets, accountability attention, leakage detection and verified leakage closure. The handoff also includes syntax qualification for the browser application and synthetic preview seeder.

## Recipient acceptance sequence

1. Clone the repository and confirm `npm run check` passes before making changes.
2. Read `docs/POS_INTEGRATION_GUIDE.md` before modifying event contracts.
3. Review `docs/KNOWN_DEPLOYMENT_PREREQUISITES.md` before any production rollout.
4. Provision a server-only `SPENDOS_API_KEY`; production mode refuses to start without one.
5. Use a non-production database for integration validation.
6. Verify POS transactional-outbox behavior and dead-letter operations.
7. Perform a real TLS-protected POS-to-SpendOS interoperability test.
8. Only then configure recurring delivery/scheduling and operational monitoring.
9. Keep backups and restore procedures for the SpendOS SQLite database.
10. Do not mark the integration live until every deployment prerequisite is resolved.

## Total Tools reference

The connector validation package was prepared against the reviewed Total Tools POS SpendOS connector worktree documented in `docs/POS_LOCAL_VALIDATION.md`. That document records the exact branch/commit used for its certification evidence.

## Known non-goals at this handoff

- SpendOS does not directly pay suppliers.
- SpendOS does not post accounting journals.
- SpendOS does not directly adjust POS inventory.
- SpendOS does not fabricate historical evidence during backfill.
- The current repository is the analytical service/API core; authoritative staff workflows remain in the POS.

For unresolved deployment items, see `docs/KNOWN_DEPLOYMENT_PREREQUISITES.md`.
