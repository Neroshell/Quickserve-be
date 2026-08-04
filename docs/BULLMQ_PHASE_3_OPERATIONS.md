# BullMQ Phase 3 Operations

Phase 3 moves only noncritical paid-order CRM projections to the dedicated
BullMQ worker. MongoDB Order payment state remains authoritative. Inventory,
refunds, order creation, reservation payment state, and operational SSE remain
in their existing synchronous paths.

## Durable processing model

- `StripeWebhookEvent` claims each verified Stripe event before business logic
  runs. Stripe is acknowledged only after that claim is marked processed.
- A paid Order stores its tenant-scoped CRM owner and processing status before
  `crm-order` is enqueued.
- `CrmOrderProjectionLedger` contains one immutable contribution per
  `{businessId, orderId}`. GuestProfile and GuestVisit are rebuilt from this
  ledger while holding a tenant-and-email projection lease.
- Existing profile/visit totals are captured once as migration baselines. The
  old capped processed-order arrays are retained for compatibility but are not
  used for deduplication.
- Failed and stale processing is visible on the Order and is found by the
  recurring `crm-order-repair-scan`.

## Rollout

1. Deploy API and worker code with `BULLMQ_POST_PAYMENT_ENABLED=false`.
   The API keeps CRM behavior available through the same durable ledger
   processor in-process while the queue flag is disabled.
2. Verify API and worker deployments share the Phase 0 Redis provider and the
   new MongoDB indexes have finished building.
3. Set `BULLMQ_POST_PAYMENT_ENABLED=true` on every API producer and on the
   dedicated worker. Only the worker registers the ten-minute repair scheduler.
4. Confirm `crm-order` jobs complete and Order fields move from `pending` to
   `completed`. Review `failed`, `crmProcessingLastError`, and enqueue-error
   fields during the verification window.
5. Run authenticated repair on demand if needed:
   `POST /internal/queue/post-payment/recover`.

## Rollback

1. Set `BULLMQ_POST_PAYMENT_ENABLED=false` on API and worker deployments and
   restart them.
2. Leave queued jobs and MongoDB CRM claim/ledger/baseline fields in place.
   Their paid-state, tenant, owner, and lease checks make later execution safe.
3. Do not delete `CrmOrderProjectionLedger`; it is the durable deduplication
   record and is required to resume without double-counting.
4. Re-enable the flag after the worker issue is corrected, then run the manual
   repair endpoint to enqueue eligible paid Orders.

Disabling the flag returns new CRM work to the in-process durable ledger path;
it never changes payment or inventory state. Phase 4 work is intentionally out
of scope.
