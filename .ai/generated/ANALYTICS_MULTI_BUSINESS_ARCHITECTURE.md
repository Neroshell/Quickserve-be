# QuickServe Multi-Business Owner Analytics Architecture

Status: architecture audit and proposal only  
Scope: owner analytics for `restaurant`, `bar_lounge`, and `hotel` businesses  
Implementation status: no production code or UI components were changed

## Executive conclusion

QuickServe should keep one `/owner/analytics` route and turn it into a capability-driven analytics shell. The existing capability contract already exposes the correct module selection signal through `capabilities.analytics.sections`, with `foodService` and `lodging` as the current section IDs.

The present implementation is not multi-business analytics. It is a large food-service dashboard that is exposed to every owner whose navigation contains Analytics. Its backend reads `Order` and `ServiceRequest`, but never reads `Reservation`; its frontend renders order, menu, preparation, tip, waiter, and table-order metrics without checking analytics capabilities.

The recommended target is:

- one shared analytics page, range selector, loading/error treatment, and shared financial summary;
- a `FoodServiceAnalytics` module for restaurant, bar/lounge, and hotel food service;
- a `HotelAnalytics` presentation module backed by the existing `lodging` capability;
- both modules on a hybrid hotel;
- thin controller orchestration;
- business-timezone-aware range utilities;
- separate shared, food-service, and lodging aggregation services;
- all monetary API fields expressed as integer minor units;
- explicit metric time bases: booking creation, payment time, operational event time, or stay overlap.

The API module key should be `lodging`, not `hotel`. `hotel` is a business identity/shell, while `lodging` is the existing module capability. This distinction is important for hybrid businesses and is consistent with the architectural constitution.

---

## 1. Current architecture

### 1.1 Frontend

The frontend implementation is concentrated in one 1,112-line client component:

| File | Current responsibility | Audit result |
| --- | --- | --- |
| `../Quick-serve-qr-menu/app/owner/analytics/page.tsx` | Authentication access, settings request, analytics request, fallback orders request, polling, range state, calculations, all cards/charts/tables, loading, and empty states | Monolithic and food-service-specific |
| `../Quick-serve-qr-menu/app/owner/analytics/loading.tsx` | Route-level generic skeleton | Reusable visual direction, but it does not reflect enabled modules and is bypassed by the page's own initial full-screen spinner after hydration |
| `../Quick-serve-qr-menu/types/owner-dashboard.ts` | Types for the analytics response | Misnamed: it is used only by `/owner/analytics`, not the owner dashboard |
| `../Quick-serve-qr-menu/hooks/use-auth-guard.ts` | Calls `/auth/me` and exposes the authenticated business's type, modules, and capabilities | Correct capability source is already available |
| `../Quick-serve-qr-menu/contexts/BusinessContext.tsx` | Exposes `businessType`, `modules`, `capabilities`, and ServicePoint terminology | Suitable for analytics module selection |
| `../Quick-serve-qr-menu/app/owner/layout.tsx` | Creates `BusinessProvider` and builds owner navigation from capabilities | Analytics navigation is capability-aware, but the analytics page body is not |
| `../Quick-serve-qr-menu/lib/axios-config.ts` | Shared credentialed Axios client | Safe to retain |

There are no dedicated analytics hooks or analytics components. Metric cards, Recharts charts, service-call cards, ServicePoint performance, and waitstaff performance are all inline in the page.

The owner layout and analytics page each instantiate `useAuthGuard`, so the
current route can make two independent `/auth/me` calls during mounting. After
authentication, the page makes three relevant reporting/configuration calls:

1. `/business/settings?businessId=...`, to obtain currency, timezone, and another copy of capabilities;
2. `/owner/analytics?...`;
3. `/owner/orders?...`, in parallel with analytics for each refresh.

The page asks `/owner/orders` for a limit of 1,000 records and uses the result only as a client-side fallback for tip metrics. `ownerOrders` does not currently apply that `limit` parameter, so the call can return every matching order in the range. The current backend analytics response now includes the tip metrics, making this second reporting request redundant when the analytics contract is reliable.

The page refreshes the two reporting calls every 60 seconds. It does not cancel stale requests when the owner changes ranges quickly.

### 1.2 Current frontend content

The page renders:

- total order revenue and a change indicator;
- orders completed and active orders;
- average order value and a change indicator;
- average preparation time and peak order hour;
- total tips, average tip, highest tip, orders with tips, and tip rate;
- order revenue trend;
- hourly order volume;
- top-selling menu items;
- menu-category performance;
- dine-in/takeout split;
- self-ordering/staff-assisted ordering split;
- waiter-call totals, statuses, response/resolution time, resolution rate, miss rate, and reasons;
- ServicePoint order performance;
- waitstaff call, service, and offline-payment performance.

Every substantive metric is based on the food-ordering domain.

### 1.3 Current frontend loading, error, and empty states

Current behavior is inconsistent:

- `loading.tsx` provides a generic route skeleton.
- The hydrated page uses a full-screen spinner when it has no data.
- A failed initial analytics request is logged to the console; `data` stays `null`, and the component ultimately renders nothing.
- Category performance has a dedicated empty state.
- ServicePoint and waitstaff performance have dedicated empty states.
- Top items can render an empty card with no explanation.
- Order/channel breakdowns render zero-value structures rather than a domain-aware no-data explanation.
- Service calls always render a full zero-valued section when the response object exists.
- There is no distinction between “module disabled,” “no activity in this range,” and “request failed.”

### 1.4 Backend

| File | Current responsibility | Audit result |
| --- | --- | --- |
| `src/routes/owner-route.js` | Protects all owner routes with `requireAuth` and `requireOwnerOrCoOwner`; exposes `GET /owner/analytics` | Correct route protection and one appropriate public owner endpoint |
| `src/controllers/ownerController.js` | Contains `ownerAnalytics` plus unrelated owner orders, dashboard, branding, and transaction handlers | Analytics handler is too large and too coupled |
| `src/services/transactionReadService.js` | Creates a unified read model from food orders and paid/chargeable reservations | Useful precedent for shared transactions, but it is not used by analytics and should not become an in-memory analytics engine |
| `src/services/businessCapabilityService.js` | Resolves identity, modules, navigation, ServicePoint capabilities, settings sections, and analytics sections | Correct source of truth for analytics module selection |

`GET /owner/analytics` is tenant-scoped with `req.session.user.businessId`; the frontend-supplied `businessId` query parameter is ignored. That is the correct security direction. The frontend should eventually stop sending the redundant parameter.

The endpoint currently performs:

- one full `Order.find(...).lean()` for the selected creation range;
- one faceted `ServiceRequest` aggregation;
- one ServicePoint order-performance aggregation;
- one faceted per-staff service-request aggregation;
- one staff payment-confirmation aggregation;
- one staff served-order aggregation;
- a later tenant-scoped ServicePoint lookup to enrich performance rows;
- extensive in-memory order, item, category, tip, time-series, and preparation calculations.

It does not query `Reservation`.

### 1.5 Date-range behavior

`ownerAnalytics` accepts `today`, `yesterday`, `7days`, `thisMonth`, and `custom`.

The current range logic:

- uses a process-wide `BUSINESS_TZ` environment value, defaulting to `Europe/Malta`;
- uses a process-wide 02:00 business-day rollover;
- applies the range to `createdAt`;
- treats custom `to` as inclusive by adding one day;
- does not reject a `from` date later than `to`;
- has no maximum custom-range size;
- duplicates similar switch logic in owner orders and owner transactions.

This is acceptable as a food-service operational-day convention, but not as a universal hotel convention. Hotel metrics require several different time bases:

- booking acquisition: `Reservation.createdAt`;
- cash receipt: `Reservation.paidAt`;
- arrivals/departures: local `checkInDate` and `checkOutDate`;
- occupancy: overlap between the requested local dates and the stay interval.

### 1.6 Models and available facts

| Model | Relevant facts available now | Important limitation |
| --- | --- | --- |
| `Business` | `businessType`, `modules`, `currency`, `timezone`, hotel check-in/out settings, food/payment preferences | Analytics does not load the business and therefore does not use tenant timezone or resolved modules |
| `Order` | Food items, categories, order type/source/status, preparation timestamps, tips, payments, staff attribution, ServicePoint snapshot labels | Major-unit totals and minor-unit financial fields coexist; current analytics uses major-unit fields |
| `Reservation` | Timeslot and stay dates, guest count, ServicePoint, status, source, price snapshot, payment status/time/amount, stay length, check-in time/staff | `confirmedAt` exists but is not written; no `cancelledAt`, `checkedOutAt`, normalized room type, or status history |
| `ServicePoint` | Stable ID, label/code, capacity, active/reservable state, price per night, beds, bed type, amenities | `servicePointType` is currently commented out in the schema, even though controllers and capabilities pass/use it |
| `GuestSession` | Tenant, ServicePoint, QR/table token, expiry | It is a food/QR session, not a hotel stay or hotel guest-request source |
| `ServiceRequest` | Tenant, ServicePoint label, reason, status, response/resolution times, handling staff | The implementation is waiter/table-oriented and lacks module, request category, reservation, and hotel guest context |
| `PendingCheckout` | Temporary food cart and payment snapshot | TTL temporary state; it must not be a reporting source |
| `StripeWebhookEvent` | Payment webhook idempotency state | Operational audit only, not the source of transaction revenue |
| `BillingInvoice` | QuickServe platform billing invoice facts | Platform billing, not guest transaction analytics |

`GuestProfile` and `GuestVisit` can support future shared guest analytics, but neither is used by the current owner analytics endpoint. `GuestVisit` is presently populated from paid food-order activity, so it should not be presented as a cross-module guest source until lodging visits are integrated.

### 1.7 Business configuration and differentiation

`businessCapabilityService` currently defines:

- restaurant default: `foodService`;
- bar/lounge default: `foodService`;
- hotel default: `lodging`;
- hotel plus food ordering: `lodging` and `foodService`;
- `capabilities.analytics.sections`: `["lodging"]`, `["foodService"]`, or both;
- hotel shell remains `hotel` when food service is enabled;
- hotel navigation gains Orders, Transactions, and Menu when food service is enabled.

The capability tests explicitly confirm that food service extends a hotel without replacing its hotel identity.

The configuration layer therefore already expresses the desired product architecture. Rendering and analytics aggregation have not caught up with it.

---

## 2. Current data flow

This section answers question A.

### A. What is the current analytics request flow?

```text
Owner opens /owner/analytics
        |
        +--> owner layout/useAuthGuard -> GET /auth/me
        |                               -> businessType/modules/capabilities
        |
        +--> analytics/useAuthGuard ----> GET /auth/me again
        |
        +--> analytics page -----------> GET /business/settings
        |                               -> currency/timezone/capabilities
        |
        +--> analytics page -----------> GET /owner/analytics
        |          |                    -> owner route auth middleware
        |          |                    -> session businessId
        |          |                    -> global-TZ date range
        |          |                    -> Order + ServiceRequest aggregates
        |          |                    -> ServicePoint enrichment
        |          |                    -> food-service DTO
        |          |
        |          +-------------------> GET /owner/orders?limit=1000
        |                               -> backend ignores limit
        |                               -> client-side tip fallback
        |
        +--> inline cards/charts/tables render
        |
        +--> repeat analytics + orders requests every 60 seconds
```

Detailed database flow:

1. `router.use(requireAuth, requireOwnerOrCoOwner)` authenticates the request.
2. `ownerAnalytics` reads the authoritative `businessId` from the session.
3. It converts the range into UTC `Date` boundaries using the process-wide timezone and rollover.
4. It reads every order document created in the range, including item arrays.
5. In parallel, MongoDB aggregates service requests, ServicePoint order performance, waiter-call handling, staff-confirmed payments, and orders served.
6. Node iterates through the loaded orders to calculate order counts, paid revenue, tips, hourly/day series, preparation time, top items, and categories.
7. It performs an additional ServicePoint lookup for IDs that start with `sp_`.
8. It returns the current flat `DashboardData` object.
9. The page separately fetches owner orders and recomputes tips only when analytics fields are absent.
10. The page reads currency/timezone from the settings response and renders every food-service section.

The current request does not resolve business capabilities in the analytics controller, does not query reservations, and does not use the unified transaction read service.

---

## 3. Shared versus domain-specific metrics

This section answers question B.

### B. Which metrics are shared, food-service-specific, or hotel-specific?

### 3.1 Metrics that are genuinely shareable

Only metrics with identical financial or temporal meaning should be shared:

| Shared metric | Definition |
| --- | --- |
| Paid gross revenue | Sum of authoritative captured guest amounts across enabled payable modules, grouped by payment time |
| Net-to-business revenue | Sum of authoritative net minor-unit amounts where available |
| Paid transaction count | Number of paid order/reservation transactions in the range |
| Average transaction value | Paid gross revenue divided by paid transaction count; label it “Average Transaction Value,” not order or booking value |
| Revenue trend | Paid gross revenue by business-local calendar date and module |
| Revenue by module | Food-service versus lodging contribution; especially important for hybrid businesses |
| Currency and range metadata | Business currency, timezone, UTC boundaries, local date boundaries, and generation time |

Reservation status, ServicePoint performance, staff performance, and service requests are not safely shareable merely because the underlying abstraction is shared. Their business meaning differs by module.

### 3.2 Food-service-specific metrics

The following belong under `modules.foodService`:

- active orders;
- completed orders;
- average order value;
- average preparation time;
- peak order hour;
- hourly orders;
- food-service revenue/order trend;
- total items sold;
- top-selling menu items;
- category performance;
- dine-in/takeout split;
- self/staff-assisted ordering channels;
- tips;
- waiter-call status, reason, response, and resolution metrics;
- table/ServicePoint order performance;
- waitstaff calls, orders served, and offline payment performance.

Restaurant and bar/lounge should share this module unchanged because their present operational model is the same.

### 3.3 Lodging/hotel-specific metrics

The following belong under `modules.lodging` and should be presented by `HotelAnalytics`:

- total booking revenue and average booking value;
- confirmed stay reservations;
- stay/booking trend;
- occupancy rate and occupied/available rooms;
- average length of stay;
- scheduled arrivals and departures;
- actual check-ins;
- pending booking payments;
- cancellation rate;
- room/ServicePoint revenue;
- normalized room-type performance;
- reservation-status breakdown;
- payment-status breakdown;
- booking-source breakdown;
- hotel guest-request analytics;
- staff check-in performance.

### 3.4 Naming corrections

| Food-service label | Hotel equivalent | Shared equivalent |
| --- | --- | --- |
| Total Revenue | Booking Revenue | Paid Revenue |
| Orders Completed | Completed/fulfilled orders | No shared equivalent |
| Average Order Value | Average Booking Value | Average Transaction Value |
| Avg Prep Time | No hotel equivalent | No shared equivalent |
| Hourly Orders | Booking or arrival trend | Transaction trend only if clearly labeled |
| Service Point Performance | Room Revenue / Room Utilization | Avoid one generic performance definition |
| Waitstaff Performance | Check-in Staff / Guest Service Performance | Staff Activity only after a shared event taxonomy exists |
| Service Call Analytics | Guest Request Analytics | Service Requests only after requests are tagged by module |

“ServicePoint” remains the canonical data abstraction. The owner-facing label and metric semantics should still be contextual: table order performance for food service and room utilization/revenue for lodging.

---

## 4. Current limitations

### C. Is the current backend controller too broad?

Yes.

`ownerAnalytics` currently owns:

- range parsing and validation;
- timezone/rollover decisions;
- six parallel model queries/aggregations;
- a later ServicePoint enrichment query;
- order revenue rules;
- tip rules;
- order-status interpretation;
- preparation-time rules;
- time-series bucketing;
- item/category aggregation;
- ServiceRequest status/reason/timing rules;
- ServicePoint performance rules;
- staff attribution merging;
- response DTO construction;
- error handling.

It is coupled to Mongoose pipelines, Luxon, environment-wide business settings, internal `sp_` ID conventions, restaurant statuses, food item structure, waiter roles, major-unit money fields, and the exact frontend DTO. Adding reservation analytics inside this function would make testing, correctness, and hybrid execution materially worse.

It also loads all matching order documents and item arrays into application memory. Long custom ranges will scale with the number and size of orders, while several additional pipelines rescan the same collections.

### D. Does the frontend assume every business has orders and waitstaff?

Yes.

The page unconditionally renders all order/menu/preparation/tip/waitstaff sections. Its only capability-related behavior is using ServicePoint terminology for one heading. A lodging-only hotel therefore receives a food-service response containing zeros and sees irrelevant cards such as Average Prep Time, Top Selling Items, Order Type Split, and Waitstaff Performance.

The page also calls `/owner/orders` for every business, including lodging-only hotels.

### E. Is there already a capability system that should drive rendering?

Yes.

The correct source is:

```text
/auth/me
  -> user.capabilities
  -> BusinessProvider
  -> useBusinessSettings()
  -> capabilities.analytics.sections
```

`capabilities.analytics.sections` already differentiates `foodService` and `lodging`. The frontend type currently declares `sections: string[]`; this should become a closed analytics-section union so an unsupported section cannot silently render nothing.

The analytics response should also report which modules it actually calculated. The backend must resolve capabilities independently from the authenticated business; frontend visibility is not authorization or backend module enforcement.

### F. Can a hotel enable food ordering?

Yes at the configuration and shell level, but the end-to-end implementation is incomplete.

Evidence of support:

- `Business.modules` accepts `lodging` and `foodService`.
- A hotel must retain `lodging` but may toggle `foodService`.
- The capability resolver preserves the hotel shell.
- Hotel navigation gains Orders, Transactions, and Menu.
- Reservation modes become `stay` and `timeslot`.
- Allowed ServicePoint types become `room` and `table`.
- Analytics sections become `lodging` and `foodService`.
- Automated capability tests cover this hybrid configuration.

Current gaps:

- `/owner/analytics` ignores those module capabilities and always calculates food analytics.
- Order endpoints do not consistently enforce the `foodService` module; current capability checks are concentrated in navigation/settings, reservations, and ServicePoint creation.
- `servicePointType` is passed by `servicePointController`, but the field is commented out in the Mongoose schema and is therefore not reliably persisted.
- Service requests have no module discriminator.
- The current flat response cannot represent both lodging and food-service metrics without naming collisions.

The correct conclusion is “hybrid business configuration exists,” not “all hybrid operations and analytics are complete.”

### G. Which current frontend pieces can be reused safely?

Safe to retain or extract:

- the single `/owner/analytics` route;
- `BusinessProvider`, `useBusinessSettings`, and the resolved capability contract;
- `useAuthGuard` for owner access;
- the shared Axios client;
- `formatPrice` and `formatTime`;
- the current range-selector behavior after range validation is centralized;
- `Button`, `Popover`, and other UI primitives;
- Recharts;
- visual card, section-header, empty-state, responsive table, tooltip, and chart-container patterns once extracted as presentation-only components;
- a generic revenue trend when it consumes the shared financial series;
- generic status-distribution and performance-table shells when labels and data are supplied by a domain module.

The existing `useReservationDashboard` is not an analytics data source. It loads full reservation records and performs client-side operational filtering and mutations. Its status labels may inform presentation, but analytics must aggregate on the backend.

### H. Which pieces should remain domain-specific?

Food-service-specific:

- order KPIs;
- preparation metrics;
- top items and categories;
- order type and ordering channels;
- tip analytics;
- waiter-call reason taxonomy;
- table order performance;
- waitstaff service/payment performance.

Lodging-specific:

- occupancy and room availability;
- arrivals/departures;
- average length of stay;
- stay lifecycle/status presentation;
- room revenue and room-type performance;
- hotel guest requests;
- check-in staff performance.

Shared visual primitives must not turn into shared business semantics. For example, both modules may use a breakdown chart, but “order type” and “reservation status” remain separate domain components and DTOs.

### I. Which existing reservation fields support hotel analytics now?

Identity and tenancy:

- `_id`, `publicReference`, `businessId`, `businessSlug`.

Booking cohort and source:

- `createdAt`, `updatedAt`, `source`.

Stay:

- `checkInDate`, `checkOutDate`, `numberOfNights`, `guestCount`;
- `servicePointId`, `servicePointLabel`;
- `pricePerNight`, `specialRequest`.

Lifecycle:

- `status`;
- `paymentExpiresAt`;
- `checkedInAt`, `checkedInBy`;
- `checkInCodeUsedAt`.

Financial:

- `subtotal`, `taxAmountCents`, `customerPlatformFeeCents`;
- `grossAmount`, `netToBusinessAmount`, `amountPaidCents`;
- `totalPrice`, `currency`;
- `paymentStatus`, `paidAt`;
- payment and pricing snapshot identifiers.

These facts are enough for an initial hotel summary if each metric states its time basis and monetary source.

### J. Which desired hotel metrics are not yet reliable?

Not fully reliable today:

- historical occupancy and historical room availability, because inventory active/reservable history and reservation status history are not stored;
- hybrid room-versus-table inventory, because `servicePointType` is not persisted;
- room-type performance, because there is no normalized `roomType`/category;
- cancellations by cancellation date, because there is no `cancelledAt`;
- actual departures and check-out staff performance, because there is no `checkedOutAt`/`checkedOutBy` workflow;
- confirmations by confirmation date, because `confirmedAt` exists but is not written;
- hotel guest-request analytics, because requests are waiter/table-oriented and not tagged by module or reservation;
- historical “pending at that time” counts, because status transitions are not retained;
- rich booking-source analysis, because `source` has only `public_hub` and `dashboard`;
- check-in service-level performance beyond counts/time-of-day, because there is no assigned staff, queue start, shift, or check-in attempt event history.

Other correctness limitations in the current food analytics should be fixed during extraction:

- `yesterdayRevenue` and `previousAverageOrderValue` are placeholders set to zero, so change percentages are not real comparisons.
- Fields named `todayRevenue`, `completedToday`, and `weekRevenue` actually represent the selected range.
- Revenue excludes tips but otherwise uses `Order.total` major units, not a clearly named gross/net minor-unit source.
- ServicePoint “revenue” includes unpaid orders in its sum.
- The main order query includes all statuses; a cancelled order can be counted as active because the active test is “not completed and not ready.”
- table performance groups first on `servicePointLabel`, which currently stores an internal ID, and relies on an additional lookup.
- category revenue can be a subset of total transaction revenue, which is why the frontend manufactures a “Remaining” chart segment.
- no focused tests currently cover `ownerAnalytics`.

---

## 5. Proposed frontend architecture

### 5.1 One capability-driven page

Keep `/owner/analytics`. Its page should do only four things:

1. read the authenticated business capability contract;
2. own the selected range;
3. call one analytics hook;
4. render shared content and enabled module renderers.

Recommended rendering rule:

| Capability section | Response module | Frontend module |
| --- | --- | --- |
| `foodService` | `modules.foodService` | `FoodServiceAnalytics` |
| `lodging` | `modules.lodging` | `HotelAnalytics` |

The component name `HotelAnalytics` is acceptable as owner-facing presentation. The capability and API key should remain `lodging`.

A lodging-only hotel renders shared financial information and hotel analytics. A restaurant or bar/lounge renders shared financial information and food-service analytics. A hotel with food service renders shared content once, then both modules.

### 5.2 Shared shell responsibilities

`AnalyticsShell` should own:

- title and explanatory subtitle;
- range selector and custom range validation;
- refresh and last-updated state;
- shared full-page error state;
- initial loading skeleton;
- shared financial summary;
- module layout/order;
- a clear empty state when no enabled module has activity.

The data hook should own:

- URL parameter construction;
- request cancellation/stale-response protection;
- refresh/polling;
- typed response parsing;
- loading, refreshing, and error states;
- no secondary `/owner/orders` request.

Currency and timezone should come from the analytics response. The page should not need a separate settings request merely to render analytics.

### 5.3 Shared visual components

Recommended presentation-only components:

- `AnalyticsHeader`;
- `AnalyticsRangeSelector`;
- `AnalyticsMetricGrid`;
- `AnalyticsMetricCard`;
- `AnalyticsSection`;
- `AnalyticsEmptyState`;
- `AnalyticsErrorState`;
- `AnalyticsSkeleton`;
- `RevenueTrendChart`;
- `BreakdownChart`;
- `PerformanceTable`;
- `MoneyValue`;
- `DurationValue`.

These components should accept labels and values. They should not decide what an order, booking, waiter, room, or reservation means.

### 5.4 Food-service components

Recommended module composition:

- `FoodServiceAnalytics`;
- `FoodServiceOverview`;
- `FoodServiceOrderTrend`;
- `FoodServiceTipMetrics`;
- `TopSellingItems`;
- `CategoryPerformance`;
- `OrderTypeBreakdown`;
- `OrderingChannelBreakdown`;
- `FoodServiceRequestAnalytics`;
- `TableOrderPerformance`;
- `WaitstaffPerformance`.

This is an extraction of current behavior, not a redesign of the metrics.

### 5.5 Hotel components

Recommended module composition:

- `HotelAnalytics`;
- `HotelBookingOverview`;
- `HotelOccupancySummary`;
- `HotelBookingRevenueTrend`;
- `HotelStayTrend`;
- `HotelArrivalDepartureSummary`;
- `ReservationStatusBreakdown`;
- `BookingPaymentStatusBreakdown`;
- `RoomRevenuePerformance`;
- `RoomTypePerformance`;
- `HotelGuestRequestAnalytics`;
- `CheckInStaffPerformance`.

Unsupported components should not be created with fabricated zero data. Add them only when the required backend facts in section 8 exist.

### 5.6 Recommended frontend file structure

```text
app/owner/analytics/
  page.tsx
  loading.tsx

components/analytics/
  shared/
    AnalyticsShell.tsx
    AnalyticsHeader.tsx
    AnalyticsRangeSelector.tsx
    AnalyticsMetricCard.tsx
    AnalyticsSection.tsx
    AnalyticsEmptyState.tsx
    AnalyticsErrorState.tsx
    RevenueTrendChart.tsx
    BreakdownChart.tsx
    PerformanceTable.tsx
  food-service/
    FoodServiceAnalytics.tsx
    FoodServiceOverview.tsx
    FoodServiceTipMetrics.tsx
    TopSellingItems.tsx
    CategoryPerformance.tsx
    OrderTypeBreakdown.tsx
    OrderingChannelBreakdown.tsx
    FoodServiceRequestAnalytics.tsx
    TableOrderPerformance.tsx
    WaitstaffPerformance.tsx
  hotel/
    HotelAnalytics.tsx
    HotelBookingOverview.tsx
    HotelOccupancySummary.tsx
    HotelArrivalDepartureSummary.tsx
    ReservationStatusBreakdown.tsx
    BookingPaymentStatusBreakdown.tsx
    RoomRevenuePerformance.tsx
    RoomTypePerformance.tsx
    HotelGuestRequestAnalytics.tsx
    CheckInStaffPerformance.tsx

hooks/
  use-owner-analytics.ts

types/
  owner-analytics.ts
  business-capabilities.ts
```

The exact number of files can be reduced during implementation when two very small presentation pieces are clearer together. The important boundary is shared shell versus domain module, not maximum file count.

---

## 6. Proposed backend architecture

### 6.1 Request orchestration

Keep `GET /owner/analytics`. The controller should:

1. require the authenticated session business ID;
2. load that `Business` by `businessId`;
3. resolve capabilities on the backend;
4. validate and resolve the requested range in the business timezone;
5. invoke only the services for enabled analytics modules;
6. invoke the shared financial service;
7. return the typed contract.

It should not perform aggregation or iterate through order/reservation records.

### 6.2 Service boundaries

Recommended backend files:

```text
src/controllers/
  ownerAnalyticsController.js

src/services/analytics/
  analyticsRangeService.js
  ownerAnalyticsService.js
  sharedAnalyticsService.js
  foodServiceAnalyticsService.js
  lodgingAnalyticsService.js

test/
  analyticsRangeService.test.js
  foodServiceAnalyticsService.test.js
  lodgingAnalyticsService.test.js
  ownerAnalyticsController.test.js
  ownerAnalyticsHybrid.test.js
```

Responsibilities:

- `analyticsRangeService`: validates presets/custom dates and produces business-local dates, UTC bounds, comparison bounds, and occupancy date boundaries.
- `ownerAnalyticsService`: capability-driven orchestrator. It contains no MongoDB expression details.
- `sharedAnalyticsService`: aggregates paid financial facts across enabled payable modules without double counting.
- `foodServiceAnalyticsService`: owns all `Order` and food-service `ServiceRequest` metrics.
- `lodgingAnalyticsService`: owns stay `Reservation`, room `ServicePoint`, hotel request, and check-in metrics.
- `ownerAnalyticsController`: HTTP/session/response boundary only.

### 6.3 Date semantics

The range object must be resolved once, but each metric must use the correct field:

| Metric family | Correct time basis |
| --- | --- |
| Food orders created/processed | `Order.createdAt`, using the documented food-service business-day boundary |
| Food revenue | Prefer `Order.paidAt`; if the product intentionally reports sales by order creation time, state that explicitly |
| Booking acquisition | `Reservation.createdAt` |
| Booking revenue | `Reservation.paidAt` |
| Arrivals | local `Reservation.checkInDate` |
| Departures | local `Reservation.checkOutDate` |
| Occupancy | stay overlap: `checkInDate < intervalEnd` and `checkOutDate > intervalStart` |
| Current pending payments | response `generatedAt` snapshot plus `paymentExpiresAt` |
| Service requests | `ServiceRequest.createdAt` |
| Check-ins | `Reservation.checkedInAt` |

Hotel calendar dates should not inherit the 02:00 food-service rollover. The range service can return both:

- a food operational-day UTC interval;
- local inclusive calendar dates and corresponding midnight UTC boundaries.

The business's stored `timezone` must replace the process-global timezone for tenant reporting.

### 6.4 Money semantics

The new contract should expose integer minor units:

- food captured/gross source: the authoritative captured cents field established by the payment flow;
- lodging captured/gross source: `amountPaidCents` for paid reservations;
- net source: `netToBusinessAmount` where populated;
- currency: normalized from `Business.currency`.

Do not sum major-unit `total`/`totalPrice` together and then round. Do not infer paid revenue from a non-paid record. Tips should be reported separately from operating revenue unless a deliberately named gross-collected metric includes them.

`transactionReadService` proves that orders and reservations can be presented in one owner transaction view, but its current implementation loads and maps full records and filters both by `createdAt`. Analytics services should use database aggregation and the correct time basis instead. Shared status/financial inclusion rules may be extracted so the transaction view and analytics do not drift.

### 6.5 Database aggregation strategy

Use MongoDB pipelines with tenant-scoped `$match` as the first stage.

Food service:

- one `Order.aggregate` with `$facet` for overview, time series, items/categories, order types/channels, tips, ServicePoint performance, and staff attribution where practical;
- one `ServiceRequest.aggregate` with `$facet` for status, reason, timing, and handler metrics;
- one tenant-scoped ServicePoint enrichment query only if immutable display snapshots are insufficient.

Lodging:

- one `Reservation.aggregate` with separate facets for created-booking, paid-revenue, stay-overlap, arrival/departure, status/payment, ServicePoint revenue, and check-in views;
- one ServicePoint inventory query scoped by `businessId`, `isActive`, `reservable`, and persisted `servicePointType: "room"` once that field is restored.

Do not load every reservation into the frontend or controller to calculate analytics.

Recommended compound indexes should be justified by actual query plans, with likely candidates:

- `Order`: `{ businessId: 1, paidAt: 1, paymentStatus: 1 }`;
- `Order`: `{ businessId: 1, createdAt: 1, status: 1 }`;
- `Reservation`: `{ businessId: 1, paidAt: 1, paymentStatus: 1 }`;
- `Reservation`: `{ businessId: 1, checkInDate: 1, checkOutDate: 1, status: 1 }`;
- `Reservation`: `{ businessId: 1, createdAt: 1, status: 1 }`;
- `ServiceRequest`: `{ businessId: 1, createdAt: 1, status: 1 }`;
- `ServicePoint`: retain `{ businessId: 1, isActive: 1 }` and include type if hybrid inventory queries require it.

### 6.6 Authorization and capability enforcement

Every analytics query must:

- derive `businessId` only from authenticated context;
- put `businessId` in every model match;
- resolve enabled modules from the stored Business;
- decline or omit a requested module that is not enabled;
- never trust a frontend module list;
- avoid cross-tenant ServicePoint enrichment.

The route's current `requireAuth` plus `requireOwnerOrCoOwner` protection should remain.

---

## 7. Proposed API response contract

Recommended contract:

```json
{
  "contractVersion": 2,
  "range": {
    "preset": "7days",
    "from": "2026-07-21",
    "to": "2026-07-27",
    "timezone": "Europe/Berlin",
    "startUtc": "2026-07-20T22:00:00.000Z",
    "endUtcExclusive": "2026-07-27T22:00:00.000Z",
    "comparison": {
      "from": "2026-07-14",
      "to": "2026-07-20"
    }
  },
  "currency": "EUR",
  "generatedAt": "2026-07-27T12:00:00.000Z",
  "enabledAnalyticsModules": ["foodService", "lodging"],
  "shared": {
    "paidRevenue": {
      "grossCents": 0,
      "netToBusinessCents": 0,
      "transactionCount": 0,
      "averageTransactionValueCents": 0,
      "comparisonPercent": null
    },
    "revenueByDay": [],
    "revenueByModule": []
  },
  "modules": {
    "foodService": {
      "overview": {},
      "tips": {},
      "revenueByDay": [],
      "hourlyOrders": [],
      "topItems": [],
      "categoryPerformance": [],
      "orderTypeBreakdown": [],
      "channelBreakdown": [],
      "serviceRequests": {},
      "servicePointPerformance": [],
      "staffPerformance": []
    },
    "lodging": {
      "overview": {},
      "bookingRevenueByDay": [],
      "bookingTrend": [],
      "occupancy": {},
      "arrivals": {},
      "departures": {},
      "reservationStatusBreakdown": [],
      "paymentStatusBreakdown": [],
      "bookingSourceBreakdown": [],
      "roomRevenuePerformance": [],
      "roomTypePerformance": [],
      "guestRequests": {},
      "checkInStaffPerformance": []
    }
  }
}
```

The zeroes and empty arrays above illustrate shape only.

Contract rules:

- Omit a module key when the module is not enabled. Do not return a fake all-zero hotel module to a restaurant or a fake food module to a lodging-only hotel.
- Return an enabled module with empty arrays/zero counts when it is enabled but has no activity.
- Keep `shared` present for every payable business.
- Use `null`, not `0`, for an unavailable comparison percentage.
- Use integer `...Cents` fields for money.
- Use ISO local dates for chart buckets and ISO instants for event timestamps.
- State the metric basis in stable field names or contract documentation.
- Return real prior-period values instead of the current placeholder comparison fields.

Why `lodging` instead of the suggested `hotel` key:

- `hotel` is `Business.businessType` and owner shell identity.
- `lodging` is the module ID already used by `Business.modules` and `capabilities.analytics.sections`.
- a capability-driven API should key data by capability;
- it prevents business identity and enabled functionality from becoming interchangeable concepts.

The frontend may still name the presentation component `HotelAnalytics`.

Migration compatibility:

- Phase 1 can keep the current flat response while moving calculations into services.
- Phase 2 can switch backend and frontend together to `contractVersion: 2`.
- With no production consumers requiring a legacy contract, a long-lived dual response is not recommended.

---

## 8. Hotel metric feasibility matrix

Legend:

- **Yes**: reliable with existing persisted fields once a backend aggregation is added.
- **Partial**: a narrower, explicitly defined form is reliable, but the full historical or operational meaning is not.
- **No**: required facts are absent or cannot be separated reliably.

| Metric | Business meaning | Source model and fields | Aggregation rule | Implementable now? |
| --- | --- | --- | --- | --- |
| Total booking revenue | Captured guest value from lodging bookings | `Reservation.paymentStatus`, `paidAt`, `amountPaidCents`, `netToBusinessAmount`, `currency` | Sum `amountPaidCents` for paid stay reservations whose `paidAt` is in range; expose net separately | **Yes** |
| Confirmed reservations | Bookings currently committed to a stay | `Reservation.status`, `checkInDate`, `createdAt`; `confirmedAt` exists but is not written | For a booking-created cohort, count current committed statuses; confirmation events by date require `confirmedAt` to be written | **Partial** |
| Occupancy rate | Share of sellable room-nights occupied | `Reservation.checkInDate`, `checkOutDate`, `servicePointId`, `status`; `ServicePoint.isActive`, `reservable` | Occupied room-nights divided by available room-nights for each local date | **Partial**: current pure-hotel inventory can be calculated; historical inventory/status and hybrid room typing are missing |
| Occupied rooms | Rooms with an overlapping blocking stay | Same overlap fields as occupancy | Count distinct room ServicePoint IDs where `checkInDate < end` and `checkOutDate > start` in blocking statuses | **Partial**: reliable for current pure hotels, not historical/hybrid without type and status history |
| Available rooms | Sellable rooms not occupied | `ServicePoint.isActive`, `reservable`; overlapping reservations | Active, reservable rooms minus occupied distinct rooms | **Partial**: current snapshot only; type is not persisted and inventory history is absent |
| Average booking value | Mean captured amount per paid lodging booking | `paymentStatus`, `paidAt`, `amountPaidCents` | Paid booking revenue divided by paid booking count for the same payment range | **Yes** |
| Average length of stay | Typical booked number of nights | `numberOfNights`, `checkInDate`, `checkOutDate`, status | Average `numberOfNights` for a documented eligible booking cohort; date difference can validate it | **Yes** |
| Arrivals today | Guests scheduled to begin a stay today; optionally actual arrivals | `checkInDate`, `status`, `checkedInAt` | Count eligible stays with local `checkInDate` today; count actual check-ins separately from `checkedInAt` | **Yes** |
| Departures today | Guests scheduled to end a stay today | `checkOutDate`, `status` | Count eligible stays with local `checkOutDate` today | **Partial**: scheduled departures yes; actual departures no because `checkedOutAt` is absent |
| Pending payments | Accepted bookings still awaiting payment | `status`, `paymentStatus`, `paymentExpiresAt` | Current count/value for `accepted_awaiting_payment` plus pending payment, separated into active and expired links | **Yes** as a current snapshot; not historically “pending at that time” |
| Cancellation rate | Portion of a booking cohort eventually cancelled | `status`, `createdAt` | Cancelled records divided by eligible bookings created in the range | **Partial**: cohort rate is possible, but cancellation-by-date is not; deletion can erase cancelled records |
| Room type performance | Demand, nights, revenue, and occupancy by room category | Desired normalized ServicePoint room type plus reservation ServicePoint ID | Join/group stays by stable normalized room type | **No**: `bedType` is not a room category and `roomType` is absent |
| Room revenue | Captured booking revenue by room | `Reservation.servicePointId`, `servicePointLabel`, `paidAt`, `amountPaidCents` | Group paid stay reservations by persisted ServicePoint ID/label | **Yes** |
| Reservation status breakdown | Current lifecycle distribution for a defined cohort | `Reservation.status`, `createdAt` or stay dates | Group the chosen booking/stay cohort by current status | **Yes** for current state; not historical transition state |
| Payment status breakdown | Paid/pending/failed/refunded distribution | `Reservation.paymentStatus`, `createdAt`, `paidAt` | Group a documented booking cohort by payment status; revenue still uses `paidAt` | **Yes** |
| Booking source breakdown | Direct public versus dashboard-created bookings | `Reservation.source` | Group stay reservations by `source` | **Partial**: current two-value source is usable but not a channel/referrer/campaign taxonomy |
| Guest request analytics | Hotel guest-request volume, reason, response, and resolution | Current `ServiceRequest` fields | Would require lodging-only request filtering and hotel request categories | **No**: no module/reservation discriminator and current flow is waiter/table-oriented |
| Staff check-in performance | Check-ins handled per staff member and timing | `Reservation.checkedInBy`, `checkedInAt`, `checkInDate`; `Business.hotelSettings.checkInTime` | Group actual check-ins by staff; optionally compare actual time with scheduled local check-in time | **Partial**: counts/time-of-day are possible; no assigned-staff, queue, shift, attempt, or check-out performance facts |

### Required model/lifecycle improvements before unsupported metrics

Minimum additions, introduced only in the phase that needs them:

- persist `ServicePoint.servicePointType`;
- add a normalized `ServicePoint.roomType` or equivalent category for lodging;
- write `Reservation.confirmedAt`;
- add and write `Reservation.cancelledAt`;
- add `Reservation.checkedOutAt` and `checkedOutBy`;
- stop deleting analytically relevant reservation history, or define an archival/soft-delete policy;
- add a module/domain discriminator and hotel context to `ServiceRequest`, reusing that model rather than creating a parallel request system;
- add lifecycle/inventory event history if arbitrary historical occupancy and historical status-at-time reports are required.

---

## 9. Hybrid-business strategy

### 9.1 Existing hybrid identity

A hybrid hotel remains:

```text
businessType: hotel
shell: hotel
modules: [lodging, foodService]
analytics sections: [lodging, foodService]
```

Food service adds a capability. It does not convert the hotel into a restaurant.

### 9.2 Data ownership by module

| Record | Module classification |
| --- | --- |
| `Order` | `foodService` |
| Stay `Reservation` with `checkInDate`/`checkOutDate` | `lodging` |
| Timeslot `Reservation` with `date`/`startTime`/`endTime` and no stay dates | `foodService` reservation flow |
| Room `ServicePoint` | `lodging`, once `servicePointType: "room"` is persisted |
| Table `ServicePoint` | `foodService`, once `servicePointType: "table"` is persisted |
| Service request | Determined by a new persisted module/context discriminator, not by label guessing |

### 9.3 Rendering

The page should iterate the ordered `capabilities.analytics.sections` list and render registered modules. This lets the capability service control availability and order without `businessType === ...` branches spread through the page.

The shared financial block renders once. Module revenue contribution is available below it without adding the two totals again in the UI.

### 9.4 Backend execution

The backend independently resolves the same capabilities:

- lodging-only: shared plus lodging services;
- food-service-only: shared plus food-service services;
- hybrid: shared plus both module services in parallel.

The shared service must union authoritative paid facts once. It must not add a “shared total” already containing modules to separate module totals and display that sum again.

### 9.5 Hybrid prerequisites

Before declaring hybrid analytics complete:

- persist ServicePoint type;
- enforce the food-service capability on food-order endpoints;
- distinguish lodging and food-service ServiceRequests;
- test mixed Order plus stay Reservation data for one tenant;
- test that another tenant's records never enter any facet;
- test a lodging-only hotel does not execute food-order queries;
- test a food-service-only business does not execute lodging queries.

---

## 10. File-by-file migration plan

### 10.1 Frontend

| File | Planned change | Phase |
| --- | --- | --- |
| `app/owner/analytics/page.tsx` | Reduce to shell, range state, typed hook, shared block, and capability-module rendering | 1–2 |
| `app/owner/analytics/loading.tsx` | Replace the fixed legacy layout with a capability-neutral analytics shell skeleton | 1 |
| `types/owner-dashboard.ts` | Move analytics-only contracts to `types/owner-analytics.ts`; stop using dashboard terminology | 1 |
| `types/business-capabilities.ts` | Type analytics section IDs as `foodService \| lodging` instead of `string[]` | 1 |
| `contexts/BusinessContext.tsx` | Retain as capability source; no new per-business branching | 1 |
| `hooks/use-owner-analytics.ts` | New typed single-request hook with range, refresh, polling, cancellation, and errors | 1 |
| `components/analytics/shared/*` | Extract presentation-only header, range, cards, section, chart, table, loading, empty, and error patterns | 1 |
| `components/analytics/food-service/*` | Move existing order/menu/tip/service/waitstaff UI without visible metric changes | 2 |
| `components/analytics/hotel/HotelAnalytics.tsx` | Add hotel module composition using `modules.lodging` | 3 |
| `components/analytics/hotel/*Summary*.tsx` | Add only currently supported hotel summary metrics | 3 |
| `components/analytics/hotel/*Chart*.tsx` and performance components | Add charts/performance as their facts become reliable | 4 |
| `lib/axios-config.ts` | No architecture change required | None |
| `app/owner/layout.tsx` | No analytics-specific change required; continue providing capabilities | None |
| `components/reservations/dashboard/useReservationDashboard.ts` | Do not reuse as the analytics data layer | None |

### 10.2 Backend

| File | Planned change | Phase |
| --- | --- | --- |
| `src/routes/owner-route.js` | Keep `GET /owner/analytics`; change its controller import after extraction | 1 |
| `src/controllers/ownerController.js` | Remove `ownerAnalytics` only after parity tests cover the extracted handler; leave unrelated owner functions untouched | 1 |
| `src/controllers/ownerAnalyticsController.js` | New thin HTTP/session/controller boundary | 1 |
| `src/services/analytics/analyticsRangeService.js` | New validated, business-timezone-aware range contract with explicit date bases | 1 |
| `src/services/analytics/ownerAnalyticsService.js` | New capability-driven orchestrator | 1 |
| `src/services/analytics/foodServiceAnalyticsService.js` | Move current Order/ServiceRequest calculations behind a tested service; first preserve visible behavior, then fix documented correctness issues deliberately | 1–2 |
| `src/services/analytics/sharedAnalyticsService.js` | New unified paid financial aggregation in integer minor units | 2 |
| `src/services/analytics/lodgingAnalyticsService.js` | New Reservation/ServicePoint aggregation service | 3–4 |
| `src/services/transactionReadService.js` | Keep as the owner transaction read model; share canonical financial/status predicates where useful, but do not load it as the analytics dataset | 2 |
| `src/services/businessCapabilityService.js` | Retain as source of truth; no new analytics business-type switch | 1 |
| `src/models/Business.js` | No analytics schema change required; use stored timezone/currency/modules | None |
| `src/models/order.js` | No hotel change; future money normalization should be separately scoped and not hidden inside analytics work | Later/separate |
| `src/models/Reservation.js` | Phase-specific lifecycle timestamps and indexes; ensure confirmation/check-out/cancellation fields are actually written | 3–4 |
| `src/models/ServicePoint.js` | Restore persisted `servicePointType`; later add normalized room type if room-type analytics is approved | 3–4 |
| `src/models/ServiceRequest.js` | Add module/context fields only when hotel guest requests are implemented; reuse the model | 4 |
| `src/models/GuestSession.js` | No hotel analytics change; do not treat QR sessions as hotel occupancy | None |
| `src/models/PendingCheckout.js` | No reporting role; retain only as temporary checkout state | None |
| `test/analyticsRangeService.test.js` | Preset, custom, timezone, DST, comparison, invalid-order, and maximum-range cases | 1 |
| `test/foodServiceAnalyticsService.test.js` | Parity plus paid/unpaid/cancelled, tips, prep, categories, ServicePoint, staff, and tenant tests | 1–2 |
| `test/lodgingAnalyticsService.test.js` | Revenue, stay overlap, arrivals/departures, status/payment, room revenue, and tenant tests | 3–4 |
| `test/ownerAnalyticsController.test.js` | Authenticated business, capability selection, response contract, and disabled-module behavior | 1–3 |
| `test/ownerAnalyticsHybrid.test.js` | Both modules, shared financial totals, ServicePoint partitioning, no duplication, and tenant isolation | 5 |

No approved `.ai/approved` file needs modification for this implementation. The proposed design follows the existing constitution and capability decisions.

---

## 11. Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Major-unit and minor-unit money are mixed in current records | Rounding errors or incomparable food/lodging totals | Define authoritative cents fields per transaction source and expose only cents in the new contract |
| Revenue time basis is ambiguous | A booking created in one range and paid in another appears in the wrong period | Use `paidAt` for captured revenue and document acquisition metrics separately |
| Global timezone/rollover is used for all tenants | Wrong day buckets, especially for hotels and DST | Load Business timezone and test DST boundaries; keep food rollover separate from hotel dates |
| Flat-contract migration breaks the current page | Temporary analytics outage | Extract with parity first, then switch backend/frontend atomically to contract v2 |
| Hybrid records cannot be partitioned by ServicePoint type | Tables can be counted as rooms | Persist and validate `servicePointType` before hybrid occupancy |
| Reservation current status is mistaken for historical status | Incorrect historical occupancy/cancellation/pending charts | Label snapshot/cohort metrics honestly; add lifecycle timestamps/history before historical claims |
| Reservation deletion removes reporting facts | Cancellation and historical booking metrics decline over time | Introduce archival/soft-delete behavior before relying on retention-based analytics |
| ServiceRequest is treated as universally shared | Hotel requests are mixed with waiter calls | Add a module/context discriminator and hotel request taxonomy before hotel request analytics |
| Full document loading for long custom ranges | Memory pressure and slow requests | Use `$facet` aggregation, enforce a range limit, add indexes, and inspect query plans |
| One failing module fails hybrid analytics | Whole page can become unavailable | Keep services isolated and well tested; decide explicitly whether contract consistency requires all-or-nothing or a typed partial-error envelope |
| Capability strings drift between backend and frontend | Enabled modules silently disappear | Use a closed frontend union, backend tests, and a module registry with an assertion for unknown IDs |
| Shared financial total double-counts module totals in UI | Inflated perceived revenue | Shared total is the union; module values are labeled contributions, never additive to the already-shared total |
| Comparison placeholders survive extraction | Misleading 100% changes | Compute equal prior periods or return `null`; never synthesize a comparison from zero |
| Existing transaction read semantics are reused blindly | Revenue is filtered by creation date instead of payment date | Reuse canonical inclusion rules only; use analytics-specific database pipelines and time bases |
| `confirmedAt` exists but is not written | False precision in confirmation trend | Write it atomically on the confirmed transition before adding the metric |
| `servicePointType` is accepted by controllers but absent in schema | False confidence in room/table differentiation | Add a schema/test prerequisite and verify persisted documents |

---

## 12. Recommended implementation phases

### Phase 1: Architecture cleanup with no visible behavior change

Deliverables:

- add focused tests around the current food analytics behavior;
- extract analytics range logic;
- move the handler into `ownerAnalyticsController`;
- move food calculations into `foodServiceAnalyticsService`;
- add `ownerAnalyticsService` orchestration;
- extract the frontend hook and shared presentation primitives;
- retain the current flat DTO through a temporary adapter;
- remove the redundant `/owner/orders` tip fallback only after analytics tip fields are tested;
- add proper initial error and empty states.

Exit criteria:

- restaurant/bar analytics display the same sections and values;
- no hotel metrics are invented;
- controller contains no aggregation logic;
- every query is tenant-scoped;
- tests cover paid/unpaid/cancelled and empty ranges.

### Phase 2: Preserve and harden restaurant/bar analytics

Deliverables:

- move the current UI into `FoodServiceAnalytics`;
- introduce the modular v2 contract;
- add the shared financial summary in cents;
- compute real prior-period comparisons or return `null`;
- correct selected-range naming;
- exclude cancelled orders from active counts;
- distinguish collected revenue from unpaid order value;
- make range handling use the Business timezone while retaining the documented food operational-day rollover;
- add query indexes based on explain plans.

Exit criteria:

- restaurant and bar/lounge render shared plus `foodService`;
- current restaurant features remain available;
- no client-side full-order analytics fallback remains;
- money and comparison semantics are documented and tested.

### Phase 3: Add reliable hotel summary analytics

Deliverables:

- persist `ServicePoint.servicePointType`;
- add `lodgingAnalyticsService`;
- add total paid booking revenue, average booking value, average length of stay, scheduled arrivals/departures, current pending payments, current status breakdown, payment breakdown, and room revenue;
- add current/pure-hotel occupied and available room summaries only with an explicit snapshot definition;
- add `HotelAnalytics` summary components;
- write required lifecycle timestamps such as `confirmedAt` before using event-date metrics.

Exit criteria:

- lodging-only hotels never execute/order-render the food module;
- hotel financial metrics use `amountPaidCents`/`paidAt`;
- hotel calendar metrics use the Business timezone;
- every hotel metric states whether it is cohort, event, stay-overlap, or current snapshot based.

### Phase 4: Add hotel charts and performance sections

Deliverables:

- booking acquisition and paid-revenue trends;
- reservation/payment/source breakdown charts;
- occupancy trend only after its inventory/history definition is approved;
- normalized room type and room-type performance, if product requirements approve the new field;
- check-out timestamps/workflow before actual-departure performance;
- hotel ServiceRequest context before guest-request analytics;
- check-in staff counts/timing, with labels limited to persisted facts;
- performance and query-plan testing for longer ranges.

Exit criteria:

- no chart implies historical facts that are not stored;
- room, guest-request, and staff metrics are domain-specific;
- empty states distinguish no activity from unavailable data.

### Phase 5: Complete hybrid-business analytics

Deliverables:

- render `foodService` and `lodging` from capability order on one page;
- run both backend module services in parallel;
- partition room/table ServicePoints by persisted type;
- partition ServiceRequests by module/context;
- combine paid transactions once in `shared`;
- show module revenue contribution without double counting;
- add full hybrid, capability, and tenant-isolation regression tests;
- enforce the food-service capability on food-ordering backend actions.

Exit criteria:

- a hotel with food service remains a hotel shell;
- both modules render independently;
- disabling food service removes its analytics and prevents its backend actions;
- shared totals equal the authoritative union of enabled-module transactions;
- no tenant, table, room, request, or financial record crosses module or business boundaries.

---

## Final recommendation

Do not create a second hotel analytics page and do not append reservation calculations to the current controller. The existing capability system already provides the necessary composition model. The safest sequence is to establish parity-tested service boundaries first, then introduce lodging metrics according to the feasibility matrix, and only claim historical occupancy, hotel requests, room-type performance, or full staff performance after their missing facts are persisted.
