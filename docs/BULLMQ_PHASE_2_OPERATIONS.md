# BullMQ Phase 2 Operations

Phase 2 moves reservation-expiry repair and billing lifecycle scheduling to the
dedicated worker. MongoDB remains authoritative; queue jobs only request
idempotent, conditionally applied work.

## Flags

All flags default to `false`:

- `BULLMQ_ENABLED`
- `BULLMQ_RESERVATION_SCHEDULERS_ENABLED`
- `BULLMQ_BILLING_SCHEDULERS_ENABLED`

The worker process (`npm run worker`) is the only process that calls BullMQ
`upsertJobScheduler`. API processes may enqueue a delayed reservation-expiry
job after an accepted reservation and its `paymentExpiresAt` are durable, but
they never register recurring schedules.

## Rollout

1. Verify Phase 0 and Phase 1 against the same Redis provider used by API and
   worker deployments.
2. Deploy the API and worker with both Phase 2 flags disabled.
3. Enable `BULLMQ_RESERVATION_SCHEDULERS_ENABLED` on API and worker deployments.
   Confirm the worker owns one five-minute repair scheduler and processes
   delayed expiry jobs. Keep the external reservation cron active during this
   verification window.
4. Enable `BULLMQ_BILLING_SCHEDULERS_ENABLED` on the worker deployment. Confirm
   one hourly scheduler exists and per-business jobs complete independently.
5. Verify MongoDB claim/status timestamps, queue failures, and manual recovery
   responses for at least one complete billing lifecycle window.
6. Disable the external scheduler that calls the cron endpoints. Do not delete
   the endpoints; retain them as authenticated manual recovery tools:
   - `POST /internal/cron/reservation-expiry`
   - `POST /internal/cron/billing-lifecycle`

Calling a recovery endpoint never creates or updates a BullMQ Job Scheduler.

## Rollback

1. Set both Phase 2 scheduler flags to `false` and restart the worker/API
   processes that consume them.
2. Re-enable the external cron schedule for reservation expiry and billing.
3. Leave delayed reservation jobs in Redis. Their tenant, payment, status, and
   expiry-version conditions make stale jobs successful no-ops.
4. Keep the MongoDB `billingLifecycleClaims` fields. Removing them during
   rollback could discard evidence needed for deduplication or recovery.

Do not automate no-show, checkout, completion, or offline usage metering as part
of this rollout.
