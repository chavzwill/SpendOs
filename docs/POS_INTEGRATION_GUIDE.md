# SpendOS POS Integration Guide

> Purpose: handoff/setup guide for a human developer or AI agent integrating a POS with SpendOS.
>
> Reference implementation: Total Tools POS. Treat the POS as the operational and financial source of truth. SpendOS receives versioned spend evidence, analyzes it, and returns advisory savings/attention intelligence.

## 1. Non-negotiable architecture

SpendOS must **not** become a second POS, AP ledger, inventory ledger, or accounting ledger.

The POS remains authoritative for:
- purchase requests, approvals, purchase orders and receipts;
- inventory movements and internal consumptions;
- supplier invoices, Accounts Payable and supplier payments;
- supplier recoverables, returns, credit notes and statement evidence;
- cost allocations, branches, departments, assets/equipment and operating commitments;
- accounting journals and financial settlement.

SpendOS is authoritative only for its own analytical/advisory records such as savings opportunities, leakage cases, targets, attention items and verified-savings analytics.

**Never let a SpendOS response directly mutate POS inventory, AP, payments, recoverables, or journals.** Any financial action must re-enter the POS through its normal permissioned, validated, idempotent workflow.

## 2. Minimum POS capabilities required

A POS is ready for SpendOS when it has stable identifiers and durable records for:
- tenant/company;
- branches/locations and departments;
- employees/users plus role/permission checks;
- suppliers;
- products/SKUs;
- purchase requests and request lines;
- purchase orders and receipts;
- inventory/internal consumption;
- supplier invoices and payments;
- cost allocation targets such as branch, department, asset, vehicle, equipment, building, project or overhead.

Strongly recommended before go-live:
- transaction support for source mutation + outbox insert;
- stable source record IDs;
- monotonic source version per mutable aggregate;
- idempotent accounting posting;
- durable audit/user identity;
- retry-safe HTTP worker;
- scheduled worker execution;
- operational monitoring and dead-letter handling.

Do not fabricate legacy data merely to satisfy SpendOS. Missing evidence must remain missing or be marked as a current-authoritative backfill snapshot.

## 3. POS environment configuration

The Total Tools reference connector uses these environment variables:

```env
SPENDOS_TENANT_ID=total-tools
SPENDOS_INGEST_URL=https://your-spendos-host.example/v1/events
SPENDOS_API_KEY=replace-with-server-to-server-secret
SPENDOS_OUTBOX_BATCH=25
SPENDOS_OUTBOX_MAX_ATTEMPTS=8
```

Meaning:
- `SPENDOS_TENANT_ID`: stable company/tenant key shared by POS and SpendOS.
- `SPENDOS_INGEST_URL`: full event-ingest URL. It is also used to derive the SpendOS service origin for management APIs.
- `SPENDOS_API_KEY`: optional in code, but production should use a strong server-to-server bearer token.
- `SPENDOS_OUTBOX_BATCH`: events claimed per worker run; clamped to 1-100.
- `SPENDOS_OUTBOX_MAX_ATTEMPTS`: terminal retry threshold; clamped to 1-50, default 8.

Do not expose `SPENDOS_API_KEY` to browsers or POS clients. Keep it server-side only.

### Same-machine local development

Docker is not required to connect Total Tools POS to SpendOS locally. When both services run on the same Windows machine, use:

```env
SPENDOS_INGEST_URL=http://127.0.0.1:4010/v1/events
```

The SpendOS repository includes a launcher that starts both services, creates an ephemeral shared server key, uses an isolated POS database by default, provisions one-time local POS sign-in credentials on that database's first boot, runs one real outbox worker batch, and verifies authenticated SpendOS access:

```powershell
npm run start:linked-pos -- --pos-dir "C:\path\to\pos_system"
```

See `docs/POS_NODE_LOCAL_SETUP.md`. Container/Compose setup is optional and should be used only when the deployment topology itself needs container qualification.

## 4. Required event envelope

Every event sent to SpendOS should use this shape:

```json
{
  "id": "tenant-or-source:aggregate-type:record-id:source-version",
  "type": "purchase.requested",
  "occurredAt": "2026-09-27T12:34:56.000Z",
  "tenantId": "total-tools",
  "source": "your-pos-name",
  "sourceRecordId": "123",
  "sourceVersion": 4,
  "actorId": "42",
  "locationId": "2",
  "departmentId": "Operations",
  "payload": {}
}
```

Rules:
- `id` must be deterministic and unique for the aggregate/version.
- `sourceRecordId` must identify the real POS record.
- `sourceVersion` must advance when the SpendOS-visible state changes.
- `occurredAt` is evidence timing, not a substitute for source-record business dates.
- `actorId` should identify the authenticated POS employee when available.
- `locationId`/branch and department should be preserved when known.
- money and quantity fields must be numeric, never formatted strings.

## 5. Reference event families

The Total Tools implementation currently emits these event families:

| POS action | SpendOS event type | Aggregate type |
|---|---|---|
| Purchase request created/current snapshot | `purchase.requested` | `purchase_request` |
| Purchase request status/converted state changes | new version of `purchase.requested` | `purchase_request` |
| Purchase receipt posted | `purchase.received` | `purchase_receipt` |
| Internal consumable issued | `consumable.issued` | `internal_consumption` |
| Operating commitment created | `operating.commitment.created` | `operating_commitment` |
| Commitment matched to invoice | `operating.commitment.invoice_linked` | `operating_commitment` |
| Commitment status changed | `operating.commitment.status_changed` | `operating_commitment` |

Future event types may be added, but preserve deterministic aggregate identity and versioning.

For internal-use purchase lines, include cost allocations in the event payload. Do not send an unallocated internal-use cost as though its destination were known.

## 6. Purchase-request payload example

The reference `purchase.requested` payload contains:

```json
{
  "requestNumber": "PR-10024",
  "requestType": "internal_use",
  "supplierId": "17",
  "currency": "JMD",
  "status": "approved",
  "backfill": null,
  "items": [
    {
      "productId": "501",
      "sku": "FILTER-01",
      "description": "Air filter",
      "quantity": 2,
      "unitCost": 3500,
      "lineTotal": 7000,
      "allocations": [
        {
          "targetType": "rental_asset",
          "targetId": "88",
          "targetLabel": "Generator GEN-088",
          "amount": 7000,
          "quantity": 2,
          "percent": 100,
          "purpose": "Scheduled service",
          "expenseCategory": "maintenance_parts",
          "valuationStatus": "declared"
        }
      ]
    }
  ]
}
```

## 7. Transactional outbox requirement

Do not call SpendOS directly inside the business transaction.

The correct pattern is:

```text
BEGIN POS TRANSACTION
  validate authority and business invariants
  mutate authoritative POS record
  increment source version when SpendOS-visible state changed
  INSERT immutable SpendOS outbox event
COMMIT
```

If the transaction rolls back, the outbox insert must roll back too.

Reference outbox fields:
- `event_id`
- `event_type`
- `aggregate_type`
- `aggregate_id`
- `source_version`
- serialized `payload`
- `status`
- `attempts`
- `last_error`
- `available_at`
- `sent_at`
- timestamps

Use a unique constraint on `event_id`. Re-emitting the same immutable event must become a no-op, not a duplicate.

## 8. Delivery worker

Reference worker:
```bash
node scripts/deliver-spendos-outbox.js
```

The worker:
1. claims eligible `pending`, `failed`, or expired `sending` rows;
2. uses a short sending lease (reference implementation: 2 minutes);
3. POSTs the serialized event to `SPENDOS_INGEST_URL`;
4. sends `Authorization: Bearer <SPENDOS_API_KEY>` when configured;
5. sends `Idempotency-Key: <event.id>`;
6. marks success as `sent`;
7. applies exponential backoff on retryable failure;
8. moves terminal failures to `dead_letter` after the configured maximum attempts.

Run this worker repeatedly using the POS host scheduler/process manager. The implementation is batch-oriented; a production schedule should be frequent enough for the required freshness while avoiding concurrent uncontrolled workers.

A dead-letter event must never be retried automatically forever.

## 9. SpendOS ingest contract

SpendOS must expose the URL configured by `SPENDOS_INGEST_URL` and accept:

```http
POST /v1/events
Content-Type: application/json
Authorization: Bearer <server key>
Idempotency-Key: <event id>
```

Expected receiver behavior:
- authenticate the server caller;
- validate tenant and event envelope;
- deduplicate by event ID/idempotency key;
- tolerate safe replay;
- reject malformed/unauthorized events with non-2xx;
- never require the POS to resend with a different event ID just to recover;
- preserve source version so stale evidence can be identified.

A 2xx response means SpendOS accepted the event. Anything else is a delivery failure and stays in the POS outbox retry/dead-letter lifecycle.

## 10. SpendOS management API expected by this POS

The POS management proxy derives the SpendOS origin from `SPENDOS_INGEST_URL`. The SpendOS service should implement:

- `POST /v1/savings/run?tenantId=...`
- `POST /v1/savings/leakage/cases?tenantId=...`
- `POST /v1/savings/leakage/cases/:id/state?tenantId=...`
- `POST /v1/savings/leakage/cases/:id/verify?tenantId=...`
- `GET /v1/savings/leakage?tenantId=...`
- `GET /v1/savings/attention?tenantId=...`
- `GET /v1/savings/targets/performance?tenantId=...`
- `POST /v1/savings/targets?tenantId=...`
- `GET /v1/savings/verified-rollup?tenantId=...`
- `GET /v1/savings/opportunities/:id?tenantId=...`
- `POST /v1/savings/opportunities/:id/actions?tenantId=...`
- `POST /v1/savings/opportunities/:id/verify?tenantId=...`

All calls use the same server-side bearer key when configured.

## 11. POS-side management/operational routes

Total Tools mounts these relevant POS route families:

```text
/api/purchase-requests
/api/cost-allocations
/api/supplier-ledger
/api/supplier-recoverables
/api/supplier-returns
/api/supplier-credit-notes
/api/supplier-recovery-attention
/api/supplier-statements
/api/supplier-statement-exceptions
/api/supplier-recovery-cases
/api/supplier-recovery-performance
/api/spendos-management
/api/operating-commitments
```

A different POS does not need identical URLs, but it needs equivalent authoritative workflows if it wants feature parity.

Important: the browser should call the POS. The POS server calls SpendOS. Do not put the SpendOS service key in frontend code.

## 12. Permissions / authority model

Reference permissions:
- `purchasing`: cost allocations/internal consumption and purchasing workflows;
- `reports_financial`: supplier ledger, cash planning, financial SpendOS management and dead-letter requeue;
- `accounts`: may participate in supplier recoverable workflows;
- some supplier-invoice creation paths accept `purchasing_approve` or `reports_financial`.

Minimum policy:
- ingest delivery is server-to-server, not an employee endpoint;
- employee-facing SpendOS management requires authenticated POS permissions;
- requeueing dead-letter events should require finance/admin authority;
- supplier payment remains a POS financial action and must not be executable by SpendOS itself;
- accepting statement differences, payment overrides and other financial exceptions must remain permissioned and audited.

Do not weaken existing POS RBAC merely to make the SpendOS UI convenient.

## 13. Cost allocation model

SpendOS is most useful when spend can be attached to what consumed it.

Reference target types include:
- branch;
- department;
- rental asset;
- vehicle;
- equipment;
- building;
- work order;
- project;
- general overhead/custom cost object.

Each allocation should preserve:
- source type and source ID;
- source line ID when allocation is line-specific;
- target type, ID and human label;
- amount and/or quantity;
- percent where applicable;
- purpose;
- expense category;
- valuation status.

For internal-use purchasing, require allocation evidence rather than silently treating the spend as generic inventory.

## 14. Supplier recovery / AP integration

For feature parity, the POS should track money owed back by suppliers for:
- shorted goods;
- damaged/rejected goods;
- supplier returns;
- credit notes;
- pricing/quantity discrepancies;
- statement differences and other evidenced recoverables.

The critical distinction is:
- **identified** exposure is a claim candidate;
- **confirmed** recoverable has accepted/evidenced accounting basis;
- only eligible confirmed amounts may be used for AP offset;
- unmatched formal credit notes remain separate until matched/settled;
- supplier payment should check usable credits/recoverables before sending more cash.

Never let SpendOS itself fabricate or confirm a supplier receivable.

## 15. Operating commitments

Recurring obligations such as rent, utilities, software, maintenance contracts and leases should be represented as operating commitments with:
- supplier/provider;
- branch/allocation target;
- cadence;
- expected amount;
- start/end dates;
- next due date;
- renewal date;
- cancellation notice;
- contract/terms reference;
- source version.

Match the real supplier invoice to the service period as evidence. Reconciliation compares expected amount to linked invoice amount.

The commitment model is planning/evidence. It must not create AP or payments by itself.

## 16. Backfilling an existing POS

Reference command:

```bash
# Always inspect first
node scripts/backfill-spendos-purchase-requests.js

# Apply only after dry-run review
node scripts/backfill-spendos-purchase-requests.js --apply
```

Optional:
```bash
node scripts/backfill-spendos-purchase-requests.js --limit=500
```

The reference backfill:
- is dry-run by default;
- classifies current, missing-current-snapshot, stale-current-snapshot and unsafe records;
- rechecks records inside a write transaction before applying;
- marks backfilled events with `backfill.basis = current_authoritative_snapshot`;
- does **not** fabricate intermediate historical states;
- skips unsafe internal-use PRs whose allocation evidence is missing;
- is replay/idempotency safe.

Do not bulk backfill by blindly emitting every historical state you can infer.

## 17. Outbox health and recovery

Reference POS endpoints:
- `GET /api/spendos-management/outbox/health`
- `POST /api/spendos-management/outbox/:id/requeue` (finance permission)

Health states:
- `healthy`: no stuck/retry/dead-letter problem detected;
- `degraded`: retryable failures, stale pending work, or expired sending leases;
- `critical`: one or more dead-letter events.

Requeue rules:
- only dead-letter events may be manually requeued;
- requeue the existing immutable event;
- keep the same event ID;
- reset delivery state/attempt counter;
- do not mutate the originating POS source record just to force redelivery.

Operational staff must be able to see the last error and retry count.

## 18. Required certification before go-live

From the Total Tools reference repository run:

```bash
npm run check:spendos-connector
npm run check:spendos-backfill
npm run check:spendos-business-journey
npm run check:spendos-guide-me
npm run check:guided-mode
node scripts/check-accounting-financial-integrity-certification.js
node scripts/check-client-syntax.js
```

Do not declare the integration live if any required gate is red.

The reference end-to-end business journey proves:

```text
purchase request / PO
  -> cost allocation
  -> partial receipt
  -> supplier shortage/recoverable
  -> supplier invoice/AP
  -> recoverable AP offset
  -> true remaining payable
  -> balanced, idempotent accounting journals
```

It must not fabricate a cash payment just to make the test balance.

## 19. Integration acceptance checklist

Before production, verify all of the following:

- [ ] Stable tenant ID configured.
- [ ] SpendOS ingest URL uses HTTPS in production.
- [ ] Server-to-server API key configured and not exposed to frontend.
- [ ] POS source IDs are stable.
- [ ] Mutable aggregates have monotonic source versions.
- [ ] Business mutation + outbox insert are one transaction.
- [ ] Event IDs are deterministic and unique.
- [ ] SpendOS receiver deduplicates/replays safely.
- [ ] Delivery worker is scheduled.
- [ ] Retry/backoff and dead-letter handling are enabled.
- [ ] Operators can see outbox health and terminal errors.
- [ ] Dead-letter requeue is permissioned.
- [ ] Cost allocations exist for internal-use spend.
- [ ] Supplier recoverables cannot be invented from SpendOS analytics.
- [ ] Supplier payment checks credits/recoverables first.
- [ ] Accounting remains POS-authoritative and idempotent.
- [ ] Existing-data backfill dry-run has been reviewed.
- [ ] Unsafe backfill rows were manually resolved or explicitly left unresolved.
- [ ] All certification commands pass.

## 20. Instructions for another AI agent

If you are an AI taking over this integration:

1. **Inspect the real POS schema and routes first.** Do not assume table or field names from this document.
2. Map each required concept to existing authoritative POS records before creating new tables.
3. Prefer extending existing purchasing/AP/accounting workflows over parallel SpendOS-specific financial ledgers.
4. Keep SpendOS analytical. Do not grant it direct inventory, AP, payment or journal authority.
5. Use transactional outbox delivery; do not POST to SpendOS inside the source mutation transaction.
6. Preserve stable IDs, tenant ID, source version and actor/location context.
7. Make every delivery replay-safe.
8. Never backfill inferred history as fact. Use explicitly marked current snapshots when history is unavailable.
9. Treat unidentified/unconfirmed supplier claims as exposure, not cash or receivables.
10. Run the repository certification gates after every integration change.

If the POS lacks one of the required authoritative workflows, stop and implement/secure that POS workflow first instead of hiding the gap inside the SpendOS connector.

## 21. Reference implementation files

Use these files to understand the Total Tools implementation:

```text
lib/spendos-outbox.js
lib/cost-allocations.js
scripts/deliver-spendos-outbox.js
scripts/backfill-spendos-purchase-requests.js
routes/purchase-requests.js
routes/cost-allocations.js
routes/purchase-order-hardening.js
routes/spendos-management.js
routes/supplier-ledger.js
routes/supplier-recoverables.js
routes/supplier-returns.js
routes/supplier-credit-notes.js
routes/supplier-statements.js
routes/supplier-statement-exceptions.js
routes/supplier-recovery-attention.js
routes/supplier-recovery-cases.js
routes/supplier-recovery-performance.js
routes/operating-commitments.js
routes/accounting-source-sync.js
```

Certification evidence lives primarily under `scripts/check-spendos-*` plus the supplier/accounting contract checks.

## 22. Definition of done

A POS is **not** SpendOS-ready because it can call an API.

It is SpendOS-ready when:
- source spend evidence is authoritative and versioned;
- delivery is transactional, idempotent, observable and recoverable;
- cost allocation survives from request through actual consumption/receipt;
- supplier money owed back is separated from unconfirmed exposure;
- supplier payments cannot ignore usable credits silently;
- recurring commitments reconcile to actual bills;
- accounting stays balanced and idempotent;
- existing data has a safe migration story;
- a complete real business journey passes end-to-end.

Only then should the integration be marked production-ready.
