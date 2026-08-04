# TODO: Durable Offline Usage-Batch Ledger

Offline Stripe commission metering is intentionally unchanged in BullMQ Phase
2 and is not scheduled by any queue.

The current controller can submit a Stripe meter event before MongoDB marks the
source orders. A process failure between those operations, or concurrent calls,
can therefore report the same orders more than once.

A future phase should design and review a durable usage-batch ledger before
automating this flow. The design must include:

- a tenant-scoped batch record with a stable idempotency/version key;
- an atomic claim of the exact source-order set;
- persisted integer-cent totals and source order identifiers;
- Stripe request idempotency tied to the durable batch;
- explicit submitted, reconciled, failed, and retryable states;
- atomic reconciliation that marks source orders only from the accepted batch;
- recovery for provider-success/database-failure ambiguity;
- protection against concurrent reporters and cross-tenant order selection.

Do not enqueue, schedule, or partially implement offline metering until that
ledger design is approved.
