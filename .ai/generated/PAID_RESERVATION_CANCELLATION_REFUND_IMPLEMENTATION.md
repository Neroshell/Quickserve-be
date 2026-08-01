# Paid Reservation Cancellation and Refund Implementation

## Scope

This change adds an explicit, provider-backed cancellation workflow for hotel
reservations. It supports:

- unpaid cancellation;
- paid cancellation with no refund;
- paid cancellation with a full refund;
- paid cancellation with a partial refund.

Reservation state and payment state remain separate. No hotel cancellation
policy engine, broad RBAC system, manual refund path, or food-order refund flow
was introduced.

## Current payment and refund architecture discovered

- Hotel payments are created by the platform Stripe account as destination
  charges.
- The Checkout Session config writes
  `payment_intent_data.application_fee_amount` and
  `payment_intent_data.transfer_data.destination`.
- `Reservation.stripePaymentIntentId` stores the original PaymentIntent after
  verified Checkout completion.
- `Reservation.stripeConnectedAccountId` stores the destination connected
  account used by the original payment.
- Before this change, Reservation had `pending`, `paid`, `failed`, and
  `refunded` payment states but no partial-refund state, durable refund ledger,
  provider refund reconciliation, or refund notification.
- Owner transactions are a read model assembled from Order and Reservation
  records rather than a separate persisted Transaction collection.
- Shared and lodging analytics use paid Reservation financial facts.

## Files created

Backend:

- `emails/ReservationRefundEmail.js`
- `src/controllers/reservationCancellationController.js`
- `src/models/ReservationRefund.js`
- `src/services/reservationCancellationService.js`
- `src/services/reservationRefundAuthorization.js`
- `test/reservationCancellationService.test.js`
- `test/reservationRefundEmail.test.js`
- `.ai/generated/PAID_RESERVATION_CANCELLATION_REFUND_IMPLEMENTATION.md`

Frontend:

- `components/reservations/dashboard/HotelReservationCancellationDialog.tsx`

## Files modified

Backend:

- `emails/ReservationCancelledEmail.js`
- `src/controllers/reservationController.js`
- `src/controllers/webhookController.js`
- `src/models/Reservation.js`
- `src/routes/owner-route.js`
- `src/services/analytics/lodging/lodgingRoomTypeAnalytics.js`
- `src/services/analytics/lodgingAnalyticsService.js`
- `src/services/analytics/sharedAnalyticsService.js`
- `src/services/transactionReadService.js`
- `src/utils/emailService.js`
- `test/lodgingAnalyticsService.test.js`
- `test/lodgingRoomTypeAnalytics.test.js`
- `test/reservationLifecycle.test.js`
- `test/sharedAnalyticsService.test.js`
- `test/transactionReadService.test.js`

Frontend:

- `app/owner/transactions/page.tsx`
- `components/analytics/hotel/HotelAnalytics.tsx`
- `components/analytics/shared/SharedAnalyticsSummary.tsx`
- `components/reservations/HotelReservationsDashboard.tsx`
- `components/reservations/dashboard/HotelReservationActionsMenu.tsx`
- `components/reservations/dashboard/ReservationPaymentStatusBadge.tsx`
- `components/reservations/dashboard/hotel-reservation-actions.ts`
- `components/reservations/dashboard/useReservationDashboard.ts`
- `reservation-lifecycle-ui.test.mjs`
- `types/owner-analytics.ts`
- `types/transaction.ts`

No file under `.ai/approved/` was modified.

## Permission rule

The current default-deny refund rule is:

- `owner`: allowed;
- `co_owner`: allowed;
- every other role, including receptionist, manager, waiter, kitchen, admin,
  and an absent role: denied.

The route is already protected by `requireAuth` and
`requireOwnerOrCoOwner`. The domain service independently calls
`canRefundReservation(user)`, so a hidden frontend action or a direct API call
cannot bypass financial authorization.

The future permission integration point is
`src/services/reservationRefundAuthorization.js`. A future explicit
`reservation.refund` permission can replace the temporary role set without
changing the refund state machine.

## API operation

The explicit operation is:

`POST /owner/reservations/:id/cancel`

It requires an `Idempotency-Key` header and accepts one server-validated
outcome:

```json
{
  "outcome": "cancel_unpaid | no_refund | full_refund | partial_refund",
  "refundAmountCents": 12000,
  "reason": "guest_request | duplicate_booking | payment_issue | hotel_unavailable | other",
  "notes": "optional"
}
```

`refundAmountCents` is accepted only for a partial refund. The backend derives
all resulting reservation and payment statuses. The generic status endpoint
rejects paid hotel cancellation and cannot be used as a financial-state bypass.

## Refund record design

`ReservationRefund` is the durable, tenant-scoped refund ledger.

Fields:

- `refundId`
- `businessId`
- `reservationId`
- `paymentProvider`
- `providerPaymentId`
- `providerRefundId`
- `connectedAccountId`
- `idempotencyKey`
- `requestFingerprint`
- `originalPaidAmountCents`
- `requestedAmountCents`
- `successfulAmountCents`
- `currency`
- `type`
- `status`
- `reason`
- `notes`
- `requestedBy.userId`
- `requestedBy.role`
- `requestedBy.name`
- `requestedBy.email`
- `failureCode`
- `failureMessage`
- `requestedAt`
- `providerCreatedAt`
- `succeededAt`
- `failedAt`
- `cancelledAt`
- `customerEmailSendingAt`
- `customerEmailSentAt`
- `customerEmailError`
- Mongoose `createdAt` and `updatedAt`

Refund status is one of `pending`, `succeeded`, `failed`, or `cancelled`.
Provider refund IDs, idempotency keys, actor snapshots, failure information,
and email delivery state are retained without card data.

Indexes:

- unique `refundId`;
- unique `idempotencyKey`;
- unique sparse `providerRefundId`;
- `{ businessId, reservationId, status }`.

## Reservation summary fields

The Reservation payment enum now includes `partially_refunded`.

Added summary and lock fields:

- `cancellationNotes`
- `cancellationOutcome`
- `cancellationIdempotencyKey`
- `cancellationOriginalPaidAmountCents`
- `cancellationRefundAmountCents`
- `refundedAmountCents`
- `lastRefundAt`
- `activeRefundId`

The existing `cancelledAt`, `cancelledBy`, and `cancellationReason` fields are
reused. `remainingRefundableAmountCents` is derived for owner responses and is
not persisted as a competing source of truth. `activeRefundId` is not exposed
to the frontend; only `refundPending` is returned.

## Cancellation outcomes

### Unpaid

- required input outcome: `cancel_unpaid`;
- Reservation becomes `cancelled`;
- payment state is unchanged;
- no Refund record is created;
- cancellation reason, notes, actor, timestamp, and idempotency key are stored.

### Paid, no refund

- required input outcome: `no_refund`;
- Reservation becomes `cancelled`;
- payment remains in its prior successful state, normally `paid`;
- captured and refunded amounts are unchanged;
- the decision is stored as `cancellationOutcome: "no_refund"`;
- the owner UI displays `Cancelled | Payment Retained`.

### Full refund

- the service calculates the remaining refundable balance;
- exactly that amount is requested from Stripe;
- a successful provider result produces
  `status: "cancelled"` and `paymentStatus: "refunded"`;
- original captured amount is never overwritten.

### Partial refund

- the request must be a safe integer greater than zero;
- it cannot exceed the remaining refundable balance;
- a successful provider result produces
  `status: "cancelled"` and `paymentStatus: "partially_refunded"`;
- original captured, cumulative refunded, and net retained amounts remain
  distinct.

The immediate cancellation workflow ends after a successful partial refund.
It does not add a post-cancellation multi-refund UI. The ledger and cumulative
calculation nevertheless handle existing successful refund entries correctly.

## Amount sources and cumulative refundable balance

Captured amount priority:

1. `Reservation.amountPaidCents`;
2. validated minor-unit `Reservation.grossAmount`;
3. the existing persisted `totalPrice` fallback, rounded once to cents.

Successful refunded amount is the greater of:

- the tenant-scoped sum of `ReservationRefund.successfulAmountCents` for
  successful records; and
- the Reservation summary `refundedAmountCents`.

Remaining refundable amount:

```text
max(0, captured amount - cumulative successful refunded amount)
```

Pending, failed, and cancelled Refund records do not reduce the balance.

## Stripe provider and Connect context

Refunds use the stored `Reservation.stripePaymentIntentId`; the frontend never
supplies a provider payment or refund identifier.

The current reservation Checkout flow creates destination charges on the
platform Stripe account. Therefore the refund is created with the platform
Stripe client and:

```js
{
  payment_intent: reservation.stripePaymentIntentId,
  amount: requestedAmountCents,
  reverse_transfer: true,
  refund_application_fee: true
}
```

This reverses the connected-account transfer and the application fee for the
destination charge. Passing the connected account as a Stripe request header
would target the wrong account for this payment architecture. The original
`stripeConnectedAccountId` is still copied to the Refund ledger for audit.

The provider response `refund.id` is stored as `providerRefundId`.

## Failure-safe operation order

Refund cancellation uses this order:

1. validate authenticated tenant, state, role, input, and cents;
2. create or load the idempotent pending Refund record;
3. acquire the Reservation `activeRefundId` conditional lock;
4. ask Stripe to refund the original PaymentIntent;
5. persist provider status and identifiers;
6. after provider success, update cumulative refund summaries;
7. transition the Reservation to cancelled;
8. send the guest refund confirmation.

If Stripe rejects the request:

- Refund becomes `failed`;
- failure code/message are stored;
- the lock is released;
- Reservation remains `confirmed`;
- the previous successful payment state remains unchanged;
- the API returns an explicit provider error;
- a deliberate retry must use a new operation key.

If Stripe returns a pending status:

- Refund remains `pending`;
- Reservation remains `confirmed`;
- the lock remains held;
- the API returns HTTP 202 and `refundPending: true`;
- a later webhook finishes or fails the operation.

## Idempotency and concurrency

- The client sends a stable `Idempotency-Key`.
- The service hashes tenant, reservation, and client key into a scoped
  cancellation key.
- `ReservationRefund.idempotencyKey` is unique.
- A request fingerprint prevents the same key from being reused with different
  outcome, amount, reason, or notes.
- The same scoped key is passed to Stripe.
- `Reservation.cancellationIdempotencyKey` makes completed no-refund, unpaid,
  and refund cancellations replay-safe.
- `activeRefundId` and conditional Reservation writes prevent two owners from
  issuing concurrent refunds or racing check-in/status updates.
- Successful Refund records are summed again before final state is derived.
- A repeated successful request returns the existing result instead of calling
  Stripe again.

## Webhook reconciliation

The existing verified Stripe webhook controller now handles:

- `refund.created`
- `refund.updated`
- `refund.failed`

Reconciliation:

- finds the Refund by stored provider ID or internal metadata;
- validates metadata tenant, reservation, internal refund ID, and original
  PaymentIntent against the stored record;
- treats duplicate successful events idempotently;
- clears the lock on provider failure/cancellation;
- finalizes Reservation state only after provider success;
- does not duplicate refund totals or customer notifications.

No parallel webhook framework was added.

## Guest email

The guest refund email is sent only after a successful provider refund. It
contains:

- reservation reference;
- check-in and check-out dates;
- amount issued in the reservation currency;
- cumulative amount refunded;
- amount retained;
- an explanation that card refunds commonly appear in 5–10 business days and
  may sometimes replace or remove the original charge.

The Refund ledger uses a database send claim plus a Resend idempotency key.
Failed delivery is recorded and a later webhook or idempotent API replay can
retry it without deliberately sending a duplicate.

No card data is logged or rendered.

## Owner reservation UX

- unpaid: `Cancel Reservation`;
- paid: `Cancel Reservation...`;
- paid cancellation opens a dialog rather than immediately changing state;
- the dialog shows reservation, guest, lifecycle, original paid, prior
  refunded, remaining refundable, currency, and stay dates;
- authorized users choose keep payment, full refund, or partial refund;
- partial values are converted to integer cents and validated against the
  remaining balance;
- canonical reason plus optional notes are collected;
- the confirmation button states the financial consequence;
- a pending provider refund disables competing lifecycle actions.

The action mapper is default-safe: unauthorized users do not receive paid
cancel/refund actions or refund controls. The dialog also contains an
`Owner approval required` fallback if reached without authority.

## Transaction display

Reservation transactions now expose:

- `originalAmountPaidCents`
- `refundedAmountCents`
- `netRetainedAmountCents`
- `refundStatus`
- `lastRefundAt`
- `refundReason`
- `refundAdjustments[]`
- `cancellationOutcome`

Successful Refund records are loaded with both `businessId` and reservation ID
scope. The original transaction amount remains unchanged. The owner table and
details drawer show original paid, total refunded, net retained, each refund
adjustment, refund date, reason, and refund ledger reference.

Cancelled paid reservations remain in the transaction read model. Archiving a
terminal Reservation remains a soft operational archive, so refund history is
not physically deleted.

## Analytics treatment

The analytics contract remains version 2 and receives additive fields:

- `refundedCents`
- `netRetainedCents`

These are present in shared paid revenue, daily revenue, and module
contributions. Lodging also exposes:

- `overview.refundedBookingRevenueCents`
- `overview.netRetainedBookingRevenueCents`
- daily lodging `refundedCents`
- daily lodging `netRetainedCents`

Semantics:

- gross collected remains the original paid amount;
- successful refunds reduce net retained;
- pending/failed refunds do not reduce net retained;
- no-refund cancellation retains the paid financial fact;
- `netToBusinessCents` becomes `null` after a lodging refund because the
  pre-refund persisted transfer snapshot is not an authoritative post-reversal
  settlement amount;
- hybrid shared totals still aggregate the food and lodging module
  contributions exactly once;
- food-order refund behavior was not added or changed.

## Audit trail

The ledger and Reservation summary retain:

- tenant/business;
- reservation;
- original provider payment ID;
- provider refund ID;
- connected-account destination snapshot;
- original paid amount;
- selected outcome;
- requested and successful refund amounts;
- cumulative refunded amount;
- actor ID, role, name, and email snapshot;
- canonical reason and optional notes;
- request/provider/success/failure/cancellation timestamps;
- failure code and message;
- customer notification state.

## Verification

- Focused refund/lifecycle/transaction/analytics/email backend suite:
  **51 passed**.
- Broader hotel, check-in, pricing, capability, analytics, lifecycle, refund,
  and transaction suite: **140 passed**.
- Existing restaurant and order-receipt regression suite: **42 passed**.
- Frontend lifecycle/refund static suite: **7 passed**.
- Frontend `npx tsc --noEmit`: passed.
- Frontend `npm run build`: passed, including `/owner/reservations`,
  `/owner/transactions`, and `/owner/analytics`.
- Modified backend implementation files: `node --check` passed.
- Backend and frontend `git diff --check`: passed.

An unrelated pre-existing suite issue remains in
`test/reservationCapacityService.test.js`: 4 tests pass and 2 controller tests
time out against an unmocked buffered Mongoose Reservation query/insert, then
receive 500 instead of the expected 400. No reservation-capacity code or test
was changed to hide that failure.

The broader run also reports an existing Mongoose warning for a duplicate
`Business.ownerEmail` index. It is outside this task.

## Existing limitations

- Only Stripe-backed hotel Reservation payments with a stored PaymentIntent can
  be refunded in-app.
- No manual/external refund recording path was added.
- No policy engine decides whether a guest receives a refund.
- No staff-to-owner approval-request workflow was invented.
- A successful partial refund cancels the Reservation; the current UI does not
  issue another partial refund after cancellation.
- The transaction date-range filter remains based on the original transaction
  record, so a later refund is viewed as an adjustment on that transaction
  rather than as a newly dated standalone transaction row.
- `netToBusinessCents` is intentionally unavailable after refund until a
  trustworthy provider settlement/reversal fact is persisted.
- Card posting time is controlled by Stripe, the card network, and the issuer;
  the 5–10 business-day message is an expectation, not a guarantee.

## Future policy and permission path

A future cancellation policy can advise an authorized user or prefill an
amount before this operation, but it must not bypass the same backend
authorization, amount validation, ledger, provider idempotency, concurrency
lock, or webhook reconciliation.

A future `reservation.refund` permission should replace the narrow role set in
`reservationRefundAuthorization.js`; no broad RBAC system was introduced here.

## Confirmations

- Unauthorized receptionist/staff roles cannot issue a refund.
- Owner and co-owner are the only currently allowed refund roles.
- Full, partial, and no-refund outcomes remain explicit user decisions.
- A provider failure does not silently cancel the Reservation or claim a
  successful refund.
- Successful refund emails are provider-result-backed and idempotent.
- Hybrid shared revenue does not double count.
- Food-service payment/refund behavior remains unchanged.
- No hotel cancellation-policy engine was added.
