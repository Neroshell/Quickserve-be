# QuickServe Owner Analytics Phase 4 Implementation

## Phase 4 scope

Phase 4 keeps `GET /owner/analytics` and `contractVersion: 2`. It adds
event-based lodging lifecycle analytics, normalized room-type performance,
and check-in/checkout staff attribution without changing food-service money
or revenue semantics.

Backend-resolved capabilities remain authoritative:

- restaurant: `foodService`
- bar/lounge: `foodService`
- lodging-only hotel: `lodging`
- hybrid hotel: `lodging`, then `foodService`

The controller remains thin. Lodging aggregation rules remain in lodging
analytics services.

## Files created

Backend:

- `src/services/analytics/lodging/lodgingAnalyticsConstants.js`
- `src/services/analytics/lodging/lodgingLifecycleAnalytics.js`
- `src/services/analytics/lodging/lodgingRoomTypeAnalytics.js`
- `src/services/reservationPaymentConfirmationService.js`
- `src/services/serviceRequestClassificationService.js`
- `test/lodgingLifecycleAnalytics.test.js`
- `test/lodgingRoomTypeAnalytics.test.js`
- `test/reservationLifecycle.test.js`
- `test/serviceRequestClassification.test.js`
- `.ai/generated/ANALYTICS_PHASE_4_IMPLEMENTATION.md`

Frontend:

- `components/analytics/hotel/HotelLifecycleAnalytics.tsx`
- `components/analytics/hotel/HotelStaffPerformance.tsx`
- `components/analytics/hotel/RoomTypePerformance.tsx`

## Files modified for Phase 4

Backend:

- `src/controllers/publicController.js`
- `src/controllers/reservationController.js`
- `src/controllers/servicePointController.js`
- `src/controllers/serviceRequestController.js`
- `src/controllers/webhookController.js`
- `src/models/Reservation.js`
- `src/models/ServicePoint.js`
- `src/models/ServiceRequest.js`
- `src/routes/owner-route.js`
- `src/services/analytics/foodServiceAnalyticsService.js`
- `src/services/analytics/lodgingAnalyticsService.js`
- `src/services/analytics/ownerAnalyticsService.js`
- `test/foodServiceAnalyticsService.test.js`
- `test/hotelCheckInController.test.js`
- `test/lodgingAnalyticsService.test.js`
- `test/ownerAnalyticsService.test.js`
- `test/servicePointType.test.js`

Frontend:

- `components/analytics/hotel/HotelAnalytics.tsx`
- `components/reservations/HotelReservationsDashboard.tsx`
- `components/reservations/dashboard/useReservationDashboard.ts`
- `components/service-points/HotelServicePointModal.tsx`
- `components/service-points/ServicePointModalFoundation.tsx`
- `types/owner-analytics.ts`
- `types/service-point.ts`

No file under `.ai/approved/` was modified.

## Persistence changes

### Reservation

Added:

- `roomTypeSnapshot: String | null`
- `confirmedBy: { userId, name, email, role } | null`
- `cancelledAt: Date | null`
- `cancelledBy: { actorType, userId, name, email, role } | null`
- `cancellationReason: String | null`
- `checkedOutAt: Date | null`
- `checkedOutBy: { userId, name, email, role } | null`
- `archivedAt: Date | null`
- `archivedBy: { userId, name, email, role } | null`

`confirmedAt` already existed. It now has an explicit `null` default and is
reliably written by real confirmation paths.

No `declinedAt`, `expiredAt`, or `noShowAt` field was added because there is
no current lodging analytics contract and verified owner workflow consuming
those event facts.

### ServicePoint

Added:

- `roomType: String | null`

The value is trimmed, internal whitespace is collapsed, and it is accepted
only when `servicePointType` is `room`. It is not inferred from a room label.
The hotel ServicePoint create/edit modal writes this field.

### ServiceRequest

Added:

- `module: "foodService" | "lodging"`
- `contextType: "table_session" | "reservation" | "room_stay" | "public"`
- `reservationId: String | null`
- `guestSessionId: String | null`
- `servicePointId: String | null`
- `requestCategory: String`

Existing waiter calls explicitly persist `module: "foodService"`. Their
module is validated against backend-resolved business capabilities. A valid
table session supplies the tenant, `guestSessionId`, and tenant-owned
`servicePointId`; authenticated staff calls use the authenticated tenant.
Food-service category normalization covers only the categories emitted by
the existing waiter-call UI.

## Exact lifecycle transition write points

### Confirmation

- Staff confirmation through
  `PATCH /owner/reservations/:id/status` writes `confirmedAt` and
  `confirmedBy` in the same tenant-scoped atomic status update.
- A paid reservation Stripe webhook writes `confirmedAt` through
  `applyReservationPaymentConfirmation`.
- Webhook retries preserve the first `confirmedAt` and first `paidAt`.
- Idempotent staff retries return the existing Reservation without rewriting
  the event timestamp or actor.

### Cancellation

- A valid transition to `cancelled` through the owner status endpoint writes
  `cancelledAt`, `cancelledBy`, and the normalized optional
  `cancellationReason` in one tenant-scoped atomic update.
- Repeated cancellation does not rewrite the first event.
- The hotel reservation UI asks for an optional cancellation reason before
  issuing the action.

### Check-in

- The existing verified
  `POST /owner/reservations/:id/check-in` action remains the only hotel
  check-in workflow.
- The generic status endpoint still rejects `checked_in`, so a client cannot
  bypass the guest code.
- The check-in update is tenant-scoped and continues writing `checkedInAt`
  and `checkedInBy`.

### Checkout

- The existing owner status endpoint is the minimum checkout action.
- Only `checked_in -> checked_out` is accepted for a hotel stay.
- It atomically writes `checkedOutAt` and `checkedOutBy`.
- `checked_in -> completed` is rejected for hotel stays, preventing an
  untracked checkout.
- Repeated `checked_out` actions preserve the first timestamp and actor.
- The hotel reservation dashboard now exposes `Checked Out` instead of the
  generic `Completed` status.

## Reservation retention and archive decision

Owner removal no longer hard-deletes a Reservation. Only terminal
Reservations can be removed from operational views. Removal writes
`archivedAt` and `archivedBy`.

Normal owner Reservation queries filter `archivedAt: null`. Lodging
analytics intentionally do not exclude archived Reservations; retained
lifecycle events remain reportable when their event timestamp is in range.

## Final `modules.lodging` contract additions

```text
lifecycle: {
  confirmations: {
    count,
    comparisonPercent
  },
  cancellations: {
    count,
    cancelledBookingCohortRatePercent,
    comparisonPercent
  },
  checkouts: {
    actualCount,
    scheduledCount,
    completedScheduledCount,
    completionRatePercent
  }
}

confirmationTrend: [
  { date, count }
]

cancellationTrend: [
  { date, count }
]

cancellationReasonBreakdown: [
  { reason, count, percentagePercent }
]

checkoutTrend: [
  { date, count }
]

roomTypePerformance: [
  {
    roomType,
    roomCount,
    paidBookingCount,
    bookedNights,
    paidRevenueCents,
    averageBookingValueCents,
    occupancyRatePercent
  }
]

checkInStaffPerformance: [
  {
    staffId,
    name,
    checkInsCompleted,
    percentagePercent,
    averageCheckInDelayMinutes
  }
]

checkOutStaffPerformance: [
  {
    staffId,
    name,
    checkOutsCompleted,
    percentagePercent,
    averageCheckoutDelayMinutes
  }
]

staffAttribution: {
  unattributedCheckIns,
  unattributedCheckOuts
}
```

The existing Phase 3 lodging fields remain unchanged.

## Confirmation metric

- Date basis: `Reservation.confirmedAt`
- Inclusion: lodging stay Reservations with a valid confirmation event in
  the current or comparison UTC interval
- Bucketing: tenant-local ISO date
- Comparison: real prior-period count; growth from zero is `null`
- Current `status: "confirmed"` without `confirmedAt` is not inferred as a
  historical event

## Cancellation metrics

- Event count and trend date basis: `Reservation.cancelledAt`
- Reason breakdown: non-empty persisted `cancellationReason`
- Event comparison: real prior-period event count

The explicitly named cohort rate is:

```text
cancelledBookingCohortRatePercent =
  current-state cancelled Reservations created in the selected range
  /
  Reservations created in the selected range whose current status is one of:
    accepted_awaiting_payment
    confirmed
    checked_in
    checked_out
    cancelled
    expired
  * 100
```

This is a current-state booking cohort, not an event rate. It is `null` when
the eligible cohort is empty.

## Checkout metrics

- Actual checkout date basis: `Reservation.checkedOutAt`
- Scheduled departure basis: business-local `checkOutDate`
- Scheduled time basis: `Business.hotelSettings.checkOutTime`
- Trend bucket: tenant-local date of `checkedOutAt`
- Completion rate:
  scheduled departures with a valid `checkedOutAt` divided by eligible
  scheduled departures in the selected calendar range
- Average delay:
  signed minutes from scheduled local checkout instant to `checkedOutAt`

No checkout is inferred from current status when `checkedOutAt` is absent.

## No-show decision

No-show event analytics were not implemented. The hotel owner UI does not
currently provide a verified no-show transition, so a passed arrival date or
current status is not treated as an event. No `noShowAt` field was added.

## Room-type performance

- Representation: normalized free-text `ServicePoint.roomType`
- Booking snapshot: `Reservation.roomTypeSnapshot`, captured from the room
  when a lodging Reservation is created
- Grouping: case-insensitive normalized room type; missing values are
  `Uncategorized`
- Revenue date basis: `paidAt`
- Revenue amount: existing authoritative lodging gross-cents expression
- Average booking value: integer cents rounded once
- Booked nights: unique `servicePointId + local stay date` overlaps in the
  selected lodging calendar range
- Inventory: current active, reservable ServicePoints where
  `servicePointType: "room"`
- Room-type occupancy:
  unique booked nights divided by current room count multiplied by selected
  calendar-day count
- Zero typed inventory: `occupancyRatePercent: null`

Tables in hybrid hotels are excluded by the tenant-scoped
`servicePointType: "room"` query.

Room-type occupancy is explicitly current-inventory-based. It is not a claim
about historical inventory.

## Lodging guest-request analytics decision

Lodging guest-request metrics were deferred.

There is no current secure hotel guest-request producer, supported lodging
request taxonomy, or hotel request-handling UI. Reclassifying free-form
food waiter calls as lodging would fabricate a domain fact. Phase 4 therefore
adds the shared module/context persistence boundary and makes all existing
waiter-call reads, writes, claims, and food analytics explicitly
`module: "foodService"`, but does not return a misleading lodging request
DTO or render a hotel request section.

A future lodging request action must explicitly write `module: "lodging"`,
validate the lodging capability, validate the tenant-owned room, and link a
tenant-owned Reservation when available before lodging request analytics are
enabled.

## Staff analytics

Check-in staff metrics use `checkedInAt`, `checkedInBy`, `checkInDate`, and
the configured business-local check-in time.

Checkout staff metrics use `checkedOutAt`, `checkedOutBy`, `checkOutDate`,
and the configured business-local checkout time.

Persisted staff IDs and name snapshots are authoritative. Records remain
attributed if a staff account is later renamed or removed. Unattributed
events remain in total event counts but are excluded from staff ranking and
reported separately. No staff score, service-quality score, or revenue
attribution was added.

## Timezone and event-date semantics

- All lifecycle instant filters use the Phase 3 lodging calendar UTC
  boundaries.
- Daily lifecycle trends use the Business timezone.
- Scheduled arrival/departure dates remain local calendar dates.
- Delay calculations create the scheduled instant from the local stay date,
  configured hotel time, and Business timezone, so DST is handled by MongoDB
  date conversion.
- Food-service 02:00 rollover is not used for lodging lifecycle events.

## Query strategy

Lifecycle analytics uses six independent tenant-scoped Reservation
aggregations in parallel:

- confirmation current/comparison/trend
- cancellation current/comparison/trend/reasons
- checkout total/trend/staff
- check-in staff
- created-booking cancellation cohort
- scheduled departure completion

Room-type analytics uses:

- one tenant-scoped paid Reservation aggregation
- one tenant-scoped stay-overlap Reservation aggregation
- one tenant-scoped room ServicePoint query

There is no query per room, Reservation, or staff member.

## Index decisions

Added and used:

- `Reservation { businessId, confirmedAt }`
- `Reservation { businessId, cancelledAt }`
- `Reservation { businessId, checkedInAt }`
- `Reservation { businessId, checkedOutAt }`
- `Reservation { businessId, createdAt, status }`
- `ServiceRequest { businessId, module, createdAt, status }`

The existing ServicePoint current-inventory index beginning with
`businessId, servicePointType` supports the room query. The existing
Reservation paid index beginning with `businessId, paymentStatus, paidAt`
supports paid room-type facts.

No `noShowAt` index was added because the metric is deferred. No roomType
index was added because room type is grouped after the tenant/type inventory
query and is not a leading filter. No speculative index was added for a
lodging ServiceRequest query that does not yet exist.

## Frontend sections

Hotel analytics now renders:

- Reservation Lifecycle summary cards
- confirmations, cancellations, and actual checkouts trend
- cancellation reasons when reasons exist
- room-type performance
- separate check-in staff activity
- separate checkout staff activity
- unattributed staff-event counts

The existing shared financial summary remains rendered once. Food-service
cards and charts were not reused to manufacture hotel facts.

The hotel ServicePoint modal includes a room-type field. The hotel
Reservation dashboard exposes the real checkout transition and captures an
optional cancellation reason.

## Verification

- Focused analytics, capability, lifecycle, ServicePoint, and controller
  suite: **78 tests passed**
- Existing hotel flow suite: **18 tests passed**
- Existing check-in suite: **7 tests passed**
- Existing pricing/email suite: **15 tests passed**
- Existing restaurant/order-receipt suite: **42 tests passed**
- Modified backend implementation files: `node --check` passed
- Frontend: `npx tsc --noEmit` passed
- Frontend: `npm run build` passed, including `/owner/analytics` and
  `/owner/reservations`
- Frontend lint could not run because `eslint` is not installed/exposed in
  the frontend project (`'eslint' is not recognized`)

A raw `node --test` is not a safe project test command in this repository:
Node also discovers `scripts/test-*.js` and the root
`test-create-manager.js`, which are database-dependent operational scripts,
not isolated tests. That discovery run reported 174 passing and 7 failing
entries. The failures included missing seeded billing data plus pre-existing
reservation-capacity and transaction-read expectation failures outside the
Phase 4 scope. The root script created one exact test manager record; that
record was immediately deleted and cleanup returned `deletedCount: 1`.

## Local development data note

There is no migration or timestamp inference.

Recreate or re-transition local development Reservations when testing:

- lifecycle events on records created before the new write paths
- actor attribution on older check-ins or checkouts
- cancellation reasons on old cancelled records
- room-type performance for old bookings without `roomTypeSnapshot`

Set `roomType` on local room ServicePoints. Existing records without a
snapshot remain `Uncategorized`; timestamps are never backfilled from
`updatedAt`.

## Remaining known limitations

- Lifecycle trends include only records with real persisted event timestamps.
- Cancellation status breakdowns remain the current status of the selected
  booking cohort, not historical status-at-time.
- Room inventory and occupancy remain current-inventory-based.
- Free-text room types are intentionally small-scope and are not a normalized
  room-type entity.
- No-show analytics are unavailable until a real hotel no-show action writes
  `noShowAt`.
- Lodging guest-request analytics are unavailable until a secure lodging
  request workflow writes explicit lodging module/context facts.
- `test-create-manager.js` is an auto-discoverable database-writing script
  containing a hard-coded database connection. It should be secured or
  removed in a separate maintenance task; Phase 4 did not modify unrelated
  operational scripts.

## Regression confirmations

- Food-service analytics calculations remain unchanged except that food
  ServiceRequest aggregation now explicitly matches
  `module: "foodService"`.
- Restaurants and bars continue to render only `foodService`.
- Lodging-only hotels execute no food-service analytics query.
- Hybrid hotels execute lodging and food-service modules independently.
- Hybrid shared revenue still unions the Order and lodging Reservation
  contributions exactly once; Phase 4 adds no new financial aggregation.
