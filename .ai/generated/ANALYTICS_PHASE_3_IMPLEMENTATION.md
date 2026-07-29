# QuickServe Owner Analytics Phase 3 Implementation

## Phase 3 scope

Phase 3 extends owner analytics contract version 2 with a real lodging
module. The existing route remains:

```text
GET /owner/analytics
```

The backend remains authoritative for module enablement:

- restaurant: `foodService`
- bar/lounge: `foodService`
- lodging-only hotel: `lodging`
- hybrid hotel: `lodging`, then `foodService`

The controller remains a thin authenticated-tenant adapter. Module
orchestration is performed in `ownerAnalyticsService`, and lodging domain
queries and response shaping are isolated in `lodgingAnalyticsService`.

This phase does not add a separate hotel analytics route, a parallel Room
model, room-type analytics, guest-request analytics, checkout analytics,
historical inventory reconstruction, payment-flow changes, email changes, or
placeholder hotel values.

## Files created in Phase 3

Backend:

- `src/services/analytics/lodgingAnalyticsService.js`
- `test/lodgingAnalyticsService.test.js`
- `test/servicePointType.test.js`
- `.ai/generated/ANALYTICS_PHASE_3_IMPLEMENTATION.md`

Frontend:

- `components/analytics/hotel/HotelAnalytics.tsx`

## Files modified in Phase 3

Backend:

- `src/controllers/servicePointController.js`
- `src/models/Reservation.js`
- `src/models/ServicePoint.js`
- `src/services/analytics/analyticsRangeService.js`
- `src/services/analytics/sharedAnalyticsService.js`
- `src/services/analytics/ownerAnalyticsService.js`
- `test/analyticsRangeService.test.js`
- `test/sharedAnalyticsService.test.js`
- `test/ownerAnalyticsController.test.js`
- `test/ownerAnalyticsService.test.js`

Frontend:

- `app/owner/analytics/page.tsx`
- `types/owner-analytics.ts`

The Phase 2 food-service files and behavior were retained. No file under
`.ai/approved/` was modified.

## Final contract

The top-level response remains contract version 2:

```js
{
  contractVersion: 2,
  range: {
    // Phase 2 compatibility fields use the food operational range.
    preset,
    from,
    to,
    timezone,
    startUtc,
    endUtcExclusive,
    comparison: {
      from,
      to,
      startUtc,
      endUtcExclusive
    },
    foodOperationalRange: {
      preset,
      from,
      to,
      timezone,
      startUtc,
      endUtcExclusive,
      comparison: {
        from,
        to,
        startUtc,
        endUtcExclusive
      }
    },
    lodgingCalendarRange: {
      preset,
      from,
      to,
      timezone,
      startUtc,
      endUtcExclusive,
      comparison: {
        from,
        to,
        startUtc,
        endUtcExclusive
      }
    }
  },
  currency,
  generatedAt,
  enabledAnalyticsModules,
  shared: {
    paidRevenue: {
      grossCents,
      netToBusinessCents,
      transactionCount,
      averageTransactionValueCents,
      comparisonPercent
    },
    revenueByDay: [
      { date, grossCents, transactionCount }
    ],
    revenueByModule: [
      { module, grossCents, transactionCount }
    ]
  },
  modules: {
    foodService?: FoodServiceAnalyticsModule,
    lodging?: LodgingAnalyticsModule
  }
}
```

`modules.lodging` is omitted when lodging is disabled. When lodging is
enabled with no activity, it is returned with supported zero values, empty
domain arrays, and `occupancyRatePercent: null` when there is no eligible
room inventory.

The lodging module shape is:

```js
{
  overview: {
    paidBookingRevenueCents,
    paidBookingRevenueComparisonPercent,
    paidBookingCount,
    averageBookingValueCents,
    averageBookingValueComparisonPercent,
    averageLengthOfStayNights,
    scheduledArrivals,
    scheduledDepartures,
    actualCheckIns,
    pendingPaymentCount,
    pendingPaymentValueCents
  },
  bookingRevenueByDay: [
    { date, grossCents, bookingCount }
  ],
  bookingTrend: [
    { date, bookingCount }
  ],
  reservationStatusBreakdown: [
    { status, count, percentagePercent }
  ],
  paymentStatusBreakdown: [
    { status, count, percentagePercent }
  ],
  bookingSourceBreakdown: [
    { source, count, percentagePercent }
  ],
  roomRevenuePerformance: [
    {
      servicePointId,
      label,
      code,
      paidBookingCount,
      paidRevenueCents,
      averageBookingValueCents,
      totalNights
    }
  ],
  arrivals: {
    scheduled,
    checkedIn,
    pending
  },
  departures: {
    scheduled
  },
  pendingPayments: {
    activeCount,
    expiredCount,
    activeValueCents,
    expiredValueCents,
    snapshotAt
  },
  occupancy: {
    occupiedRoomNights,
    availableRoomNights,
    occupancyRatePercent,
    occupiedRoomsForToday,
    availableRoomsForToday
  }
}
```

Every field ending in `Cents` is an integer minor-unit amount. Breakdown
percentages use the explicit `percentagePercent` name. Date buckets are
tenant-local ISO dates, while boundaries, `generatedAt`, and `snapshotAt`
are ISO UTC instants.

## Lodging capability behavior

`ownerAnalyticsService` uses
`resolveBusinessCapabilities(business).analytics.sections`; it does not
trust a module query from the frontend and does not branch directly on
`businessType`.

Shared financial aggregation runs only the enabled payable persistence
domains. The enabled module services are then run in parallel:

- restaurant and bar/lounge query Orders and food-service ServiceRequests;
- lodging-only hotels query Reservations and lodging ServicePoints and do
  not query Orders or food-service ServiceRequests;
- hybrid hotels run both independent module services.

The order of `enabledAnalyticsModules` and rendered frontend modules is the
server capability order.

## Stay-versus-timeslot classification

A lodging stay is a Reservation with both:

- a string `checkInDate` matching `YYYY-MM-DD`; and
- a string `checkOutDate` matching `YYYY-MM-DD`.

Timeslot reservations use the separate `date`, `startTime`, and `endTime`
fields and do not enter lodging revenue or lodging operational metrics.
Labels are never used to infer reservation mode.

## Reservation fields used

Lodging analytics uses these persisted Reservation fields:

- tenant and classification: `businessId`, `checkInDate`, `checkOutDate`;
- acquisition: `createdAt`;
- payment recognition: `paymentStatus`, `paidAt`;
- authoritative paid amount: `amountPaidCents`, then `grossAmount`;
- reliable net test: `netToBusinessAmount`;
- lifecycle: `status`;
- booking source: `source`;
- stay duration: `numberOfNights`;
- room attribution: `servicePointId`, `servicePointLabel`;
- pending-payment snapshot: `paymentExpiresAt`;
- actual check-in: `checkedInAt`.

ServicePoint enrichment uses:

- `businessId`
- `servicePointId`
- `label`
- `code`
- `servicePointType`
- `isActive`
- `reservable`

All Reservation and ServicePoint queries include the authenticated
`businessId`.

## Lodging date semantics

Food-service analytics retains its 02:00 tenant-local operational rollover.
Lodging uses independent tenant-local calendar-midnight boundaries.
`analyticsRangeService` constructs every current and comparison boundary as
a local instant before converting it to UTC, including DST transitions.

Metric date bases are intentionally separate:

- booking-created trend and the three booking-cohort breakdowns:
  `Reservation.createdAt`;
- paid booking revenue and room revenue:
  `Reservation.paidAt`;
- scheduled arrivals: local `Reservation.checkInDate`;
- scheduled departures: local `Reservation.checkOutDate`;
- actual check-ins: `Reservation.checkedInAt`;
- pending payments: current `generatedAt` snapshot.

Lodging revenue and average booking value use the existing equal prior
calendar-period comparison. Growth is `null` when the prior value is zero
and the current value is positive.

## Booking revenue definition

Paid booking revenue includes only stay Reservations with:

- `paymentStatus: "paid"`;
- a `paidAt` instant in the current or comparison lodging calendar range;
- a positive authoritative cents amount.

The paid amount source is:

1. positive persisted `amountPaidCents`;
2. otherwise positive persisted `grossAmount`;
3. otherwise the reservation is excluded from financial totals.

There is no `createdAt` fallback for a paid stay missing `paidAt`. The
verified reservation payment lifecycle writes `paidAt`; silently using
booking acquisition time would mix two different date bases. No legacy
compatibility path was added.

`totalPrice` is not converted or recalculated for analytics because the
minor-unit payment snapshots are the authoritative sources.

Unpaid and refunded Reservations are excluded. A paid record remains a
financial fact unless its persisted payment state records the reversal.

## Status sets

Average-length-of-stay eligible statuses:

```text
pending
pending_approval
accepted_awaiting_payment
confirmed
checked_in
checked_out
```

Scheduled arrival/departure statuses:

```text
confirmed
checked_in
checked_out
```

Inventory-blocking statuses:

```text
accepted_awaiting_payment
confirmed
checked_in
```

Active pending-payment status:

```text
accepted_awaiting_payment
```

Expired pending-payment statuses:

```text
accepted_awaiting_payment
expired
```

Non-service terminal statuses are documented as:

```text
cancelled
declined
expired
no_show
```

The status, payment-status, and source breakdown cohort is all stay
Reservations created in the selected range. Each breakdown reports the
record's current stored value; it is not historical status-at-time
reconstruction.

## Average stay, arrival, and departure definitions

Average length of stay uses the documented eligible status cohort, booking
`createdAt` in the selected range, and a persisted `numberOfNights >= 1`.
Malformed and zero-night records are excluded. The average is rounded to
one decimal place.

Scheduled arrivals count the scheduled-status cohort with `checkInDate` in
the selected local calendar range. Scheduled departures use `checkOutDate`.
These are schedule facts, not actual execution claims.

Actual check-ins count persisted `checkedInAt` instants in the selected UTC
interval. No checkout-performance metric was added because no reliable
`checkedOutAt` field exists.

## Pending-payment definition

Pending payment is a generated-at snapshot, not a historical range metric.

Active:

```text
paymentStatus = pending
status = accepted_awaiting_payment
paymentExpiresAt > generatedAt
```

Expired:

```text
paymentStatus = pending
status in [accepted_awaiting_payment, expired]
paymentExpiresAt <= generatedAt
```

Confirmed and cancelled reservations are not treated as pending merely
because their payment status is not paid. Snapshot values use the same
persisted cents-source rule as booking financials; missing reliable amounts
contribute zero value without inventing a price.

## Room revenue definition

Room performance groups the same paid lodging revenue population by
persisted `servicePointId`. It returns paid booking count, paid revenue,
integer-rounded average booking value, and the sum of valid persisted
`numberOfNights`.

One tenant-scoped ServicePoint query enriches all groups with the current
display `label` and `code`; it also supplies the typed room inventory for
occupancy. There is no query per room.

## Occupancy decision

Occupancy was implemented because the required current schema facts are
available after narrowly restoring persisted `ServicePoint.servicePointType`:

- `room` is distinguishable from `table`;
- active inventory uses `isActive: true`;
- reservable inventory uses `reservable: true`;
- blocking Reservation statuses are defined;
- stay dates are persisted as `checkInDate` and `checkOutDate`.

The calculation is explicitly current-inventory-based:

```text
unique occupied room/date pairs
/
current active reservable room count × selected local calendar days
```

Stay overlap uses:

```text
checkInDate < intervalEnd
checkOutDate > intervalStart
```

Overlapping or duplicate reservations for the same room and date are
deduplicated, so occupied room-nights cannot be inflated beyond one room on
one date. Hybrid table ServicePoints are excluded.

`occupiedRoomsForToday` and `availableRoomsForToday` use `generatedAt`'s
tenant-local calendar date and current inventory. If available room-nights
are zero, `occupancyRatePercent` is `null`.

This is not historical inventory reconstruction. Adding/removing/deactivating
rooms changes the denominator used for prior selected date ranges because
ServicePoint inventory state is not versioned.

## ServicePoint type prerequisite

`ServicePoint.servicePointType` is now a required persisted enum:

```text
table
room
booth
other
```

Create and update flows validate the requested type against
server-resolved business capabilities. Lodging allows `room`; food service
allows `table`; a hybrid supports both. No separate Room model was added.

No migration or compatibility layer was introduced. Existing local
development ServicePoints without `servicePointType` should be recreated
through the current owner ServicePoint flow before occupancy is evaluated.

## Shared hybrid revenue behavior

`sharedAnalyticsService` runs conditional module-aware aggregations:

- Order aggregation for `foodService`;
- Reservation aggregation for `lodging`.

For hybrids, the module contributions are combined exactly once into
`shared.paidRevenue` and `shared.revenueByDay`. `revenueByModule` exposes the
two contributions without asking the frontend to add them to the shared
total again.

Orders and Reservations are disjoint persistence domains, and each query is
executed once per request. Timeslot Reservations are excluded from the
lodging contribution. Shared `netToBusinessCents` is `null` when any
included paid Order or Reservation lacks a reliable persisted net amount.

## Query strategy

Shared analytics:

- one conditional tenant-scoped Order aggregation for food financials;
- one conditional tenant-scoped Reservation aggregation for lodging
  financials;
- the two run in parallel when both modules are enabled.

Lodging analytics:

- one tenant-scoped Reservation aggregation with facets for booking trend,
  cohort breakdowns, stay length, arrivals, departures, actual check-ins,
  room revenue, and occupancy overlap;
- one tenant-scoped Reservation aggregation for the current pending-payment
  snapshot;
- one tenant-scoped ServicePoint lookup for all performance metadata and
  current active/reservable room inventory.

No food-service query executes for a lodging-only request.

## Indexes

Added to Reservation:

```js
{ businessId: 1, paymentStatus: 1, paidAt: 1 }
{ businessId: 1, paymentStatus: 1, status: 1, paymentExpiresAt: 1 }
{ businessId: 1, checkInDate: 1, checkOutDate: 1, status: 1 }
```

These support paid booking recognition, current pending-payment snapshots,
and stay-overlap queries respectively.

Added to ServicePoint:

```js
{
  businessId: 1,
  servicePointType: 1,
  isActive: 1,
  reservable: 1
}
```

This supports the current eligible-room inventory lookup.

No speculative room-type, checkout, or cancellation indexes were added.
No standalone `checkedInAt` or Reservation `createdAt` compound index was
added because those facets operate after the tenant/stay cohort match in the
current aggregation shape; an index that cannot serve the leading match
would not justify its write cost.

## Frontend implementation

`HotelAnalytics` renders:

- Paid Bookings
- Average Booking Value
- Average Length of Stay
- Scheduled Arrivals
- Scheduled Departures
- Actual Check-ins
- Active and expired pending-payment snapshot and values
- Current-inventory occupancy
- Booking Revenue chart
- Booking-created trend
- Reservation status breakdown
- Payment status breakdown
- Booking source breakdown
- Room performance table

Canonical API status/source values remain in the contract and are converted
to friendly labels only for display. Every amount uses the response
currency; no currency is hardcoded.

`app/owner/analytics/page.tsx` renders modules by
`enabledAnalyticsModules` order and module presence. It does not branch on
`businessType`. The temporary Phase 2 lodging-unavailable state was removed.
`SharedAnalyticsSummary` is rendered once before module sections, including
for hybrids.

## Tests and verification

Focused backend analytics suite:

```text
50 passed
0 failed
```

This includes range, shared union, food-service, lodging, ServicePoint type,
owner orchestration, and controller coverage.

Additional backend regression suites:

- capability suite: 9 passed
- hotel-flow suite: 18 passed
- check-in suite: 7 passed
- pricing suite: 15 passed
- restaurant/order-receipt suite: 42 passed

Backend modified implementation files:

```text
node --check: passed
```

Frontend:

```text
npx tsc --noEmit: passed
npm run build: passed
```

The production build includes `/owner/analytics`.

The configured frontend lint command could not run because the repository
does not currently expose an `eslint` executable:

```text
'eslint' is not recognized as an internal or external command
```

No dependency or lint configuration was introduced for this scoped phase.

## Unsupported or intentionally deferred metrics

The following remain intentionally absent:

- normalized room-type performance: no normalized reliable `roomType`;
- actual checkout performance: no reliable `checkedOutAt`;
- cancellation-by-date trend: no reliable `cancelledAt`;
- confirmation-by-date trend: not part of this phase;
- historical status or pending-payment reconstruction;
- historically accurate inventory denominators;
- lodging guest-request analytics: ServiceRequest has no lodging
  discriminator;
- hotel staff productivity beyond persisted check-in counts.

## Remaining limitations

- Occupancy uses current room inventory for every selected range because
  ServicePoint inventory history is not persisted.
- Existing local ServicePoints without a persisted type are excluded from
  room inventory until local data is recreated through the current flow.
- A paid Reservation without `paidAt` is deliberately excluded rather than
  assigned an invented revenue date.
- Breakdown values describe the current status of a booking-created cohort,
  not the status that each reservation held on each historical date.

## Completion confirmations

- Food-service calculations and visible restaurant/bar design remain
  unchanged from Phase 2.
- Restaurants and bars render only `modules.foodService`.
- Lodging-only hotels render only `modules.lodging` and execute no
  food-service analytics queries.
- Hybrid hotels render lodging and food-service modules in capability order.
- Shared financial cards render once.
- Hybrid shared revenue includes each Order and lodging Reservation
  contribution exactly once.
- No canonical `.ai/approved/` document was modified.
