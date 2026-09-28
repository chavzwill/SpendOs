# Known Deployment Prerequisites

These items do not invalidate the code handoff, but they must be resolved or explicitly accepted before a production go-live.

## Already verified

- SpendOS core syntax and automated tests pass.
- 29 core tests pass.
- The Total Tools POS connector's seven required local certification commands pass.
- Connector tests use isolated/disposable data.
- No live production credentials or live SpendOS endpoint were used during local certification.

## Production prerequisites

1. **Real interoperability test**
   Run the actual POS connector against the deployed SpendOS service over the intended network path and TLS configuration. Confirm authentication, tenant handling, replay behavior and all management endpoints.

2. **Container/deployment validation**
   The prior connector validation host did not have Docker available. Render/build the intended production composition and run production preflights in the real deployment environment.

3. **Scheduler/worker operations**
   Configure a controlled recurring delivery worker for the POS outbox. Prevent uncontrolled overlapping workers and document operator recovery.

4. **Network timeouts and lease behavior**
   The reference POS worker/proxy fetch calls were previously noted as lacking explicit application timeouts. The outbox uses a sending lease but the reviewed implementation did not have a lease-owner token guarding completion updates. Qualify slow-request, retry and overlapping-worker behavior before production scheduling.

5. **Authentication**
   The SpendOS service now refuses to start in `NODE_ENV=production` without `SPENDOS_API_KEY`. Keep the key server-side only and rotate it through normal secret-management procedures.

6. **Ingress and TLS**
   SpendOS listens on loopback by default. Expose it only through an authenticated, TLS-protected ingress/reverse proxy or equivalent trusted service network.

7. **Database operations**
   Define backup, restore, retention and recovery procedures for the SQLite database and verify them against a non-production copy.

8. **Monitoring**
   Monitor service health, POS outbox age, retries, dead letters, ingestion errors and database capacity. Define who responds and how events are requeued.

9. **Backfill**
   Use dry-run first. Do not infer missing historical states. Resolve unsafe or unallocated internal-use records before applying a backfill.

10. **Authority and RBAC**
    Employee-facing actions remain permissioned in the POS. SpendOS must not gain direct authority over inventory, AP, payments, supplier recoverables or accounting journals.

## Go-live evidence expected

Before declaring production live, retain evidence of:
- production-mode SpendOS startup with secret injection;
- TLS/authenticated POS-to-SpendOS event delivery;
- replay/idempotency behavior;
- stale/conflict handling;
- management API access through the POS server;
- dead-letter creation and permissioned requeue;
- worker timeout/recovery behavior;
- database backup and restore;
- the full POS business journey certification.

The local certification logs in `docs/certification/` establish the tested baseline. They do not substitute for deployment-specific evidence.
