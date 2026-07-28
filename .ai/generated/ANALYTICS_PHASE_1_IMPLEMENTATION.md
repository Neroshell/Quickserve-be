# Analytics Phase 1 Implementation

## Scope

Phase 1 extracts the existing food-service owner analytics implementation into
clear backend and frontend boundaries. It keeps `GET /owner/analytics`, keeps
the existing flat response DTO, and does not implement lodging analytics.

No file under `.ai/approved/` was changed.

## Files created

### Backend

- `src/controllers/ownerAnalyticsController.js`
- `src/services/analytics/analyticsRangeService.js`
- `src/services/analytics/ownerAnalyticsService.js`
- `src/services/analytics/foodServiceAnalyticsService.js`
- `test/analyticsRangeService.test.js`
- `test/foodServiceAnalyticsService.test.js`
- `test/ownerAnalyticsController.test.js`
- `test/ownerAnalyticsService.test.js`
- `.ai/generated/ANALYTICS_PHASE_1_IMPLEMENTATION.md`

### Frontend

- `hooks/use-owner-analytics.ts`
- `types/owner-analytics.ts`
- `components/analytics/food-service/FoodServiceAnalytics.tsx`
- `components/analytics/shared/AnalyticsShell.tsx`
- `components/analytics/shared/AnalyticsHeader.tsx`
- `components/analytics/shared/AnalyticsRangeSelector.tsx`
- `components/analytics/shared/AnalyticsMetricCard.tsx`
- `components/analytics/shared/AnalyticsSection.tsx`
- `components/analytics/shared/AnalyticsEmptyState.tsx`
- `components/analytics/shared/AnalyticsErrorState.tsx`
- `components/analytics/shared/AnalyticsSkeleton.tsx`

## Files modified

### Backend

- `src/controllers/ownerController.js`
  - Removed the complete `ownerAnalytics` HTTP handler and its embedded
    analytics implementation.
  - Relocated four model imports used by the remaining owner dashboard
    functions to the top import block.
- `src/routes/owner-route.js`
  - Kept the `/owner/analytics` route and changed only its controller import.

### Frontend

- `app/owner/analytics/page.tsx`
  - Reduced from 1,112 lines to 112 lines, a net reduction of 1,000 lines.
- `app/owner/analytics/loading.tsx`
  - Reuses the extracted analytics skeleton.
- `types/owner-dashboard.ts`
  - Removed after confirming it contained only analytics types and had no
    remaining consumers.

The existing local modification to `app/owner/transactions/page.tsx` was
present before this task and was not changed as part of Phase 1.

## Previous request flow

1. `app/owner/analytics/page.tsx` authenticated the owner.
2. The page fetched business settings.
3. The page fetched `/owner/analytics` and `/owner/orders` together.
4. The page recalculated tip metrics from orders as a fallback.
5. The page owned polling, range parameters, loading, refresh timestamps,
   calculations, all charts, all tables, and all states.
6. `ownerController.ownerAnalytics` resolved the range, executed every Order,
   ServiceRequest, and ServicePoint query, calculated every metric, enriched
   ServicePoints, and returned the response.

## New request flow

1. `app/owner/analytics/page.tsx` reads the existing business capability
   context, owns the selected range, and chooses the Phase 1 module state.
2. `useOwnerAnalytics` fetches settings and `GET /owner/analytics`, owns polling,
   refresh state, error state, last-updated state, and request cancellation.
3. The unchanged route calls the thin `ownerAnalyticsController`.
4. The controller takes `businessId` only from the authenticated session and
   passes the range request to `ownerAnalyticsService`.
5. `ownerAnalyticsService` resolves the range and invokes
   `foodServiceAnalyticsService`.
6. `foodServiceAnalyticsService` performs the existing tenant-scoped queries,
   calculations, enrichment, and flat response shaping.
7. The frontend renders the unchanged food-service sections through
   `FoodServiceAnalytics` and shared presentation-only components.

## Backend responsibility boundaries

### `ownerAnalyticsController`

- Authenticated request context
- Range query extraction
- Service invocation
- HTTP response and controller-level error handling

It contains no database query or metric rule.

### `analyticsRangeService`

- Existing `today`, `yesterday`, `7days`, `thisMonth`, and `custom` behavior
- Existing process-wide timezone and 02:00 business-day rollover
- Missing, malformed, and reversed custom-range validation

It does not define lodging date semantics.

### `ownerAnalyticsService`

- Phase 1 orchestration only
- Range resolution
- Food-service service invocation
- Return of the current flat DTO

It contains no business-type branching and no lodging implementation.

### `foodServiceAnalyticsService`

- Tenant-scoped Order queries
- Tenant-scoped ServiceRequest aggregations
- Tenant-scoped ServicePoint enrichment
- Revenue, tips, order, preparation, item, category, channel, service-call,
  ServicePoint, and waitstaff calculations
- Existing flat response shaping

## Frontend responsibility boundaries

### Route page

- Existing capability/context read
- Range state
- Module selection
- Loading, error, empty, and lodging-unavailable composition

### `useOwnerAnalytics`

- Axios analytics/settings requests
- Polling and manual refresh
- Initial loading versus background refreshing
- Visible error state data
- Last-updated timestamp
- AbortController cancellation and request sequence protection

### Shared components

- Presentation-only shell, header, selector, metric card, section, skeleton,
  error state, and empty state
- No food-service metric definitions or domain rules

### `FoodServiceAnalytics`

- Existing restaurant/bar cards, charts, breakdowns, ServicePoint table, and
  waitstaff table
- Existing display calculations such as comparison percentages and chart data

## `/owner/orders` fallback decision

The redundant `/owner/orders` request was removed.

`GET /owner/analytics` always returns:

- `totalTipsCollected`
- `averageTip`
- `highestTip`
- `ordersWithTips`
- `tipRate`

These fields are required in `OwnerAnalyticsStats` and are covered by the
food-service analytics regression test for paid, unpaid, and tipped orders.
The frontend now displays the endpoint values directly.

## Behavior intentionally preserved

- The public endpoint remains `GET /owner/analytics`.
- The response remains the existing flat DTO; no `modules.foodService` wrapper
  was added.
- Existing date presets and the 02:00 rollover remain.
- Existing revenue and tip calculations remain.
- Existing order, item, category, channel, service-call, ServicePoint, and
  waitstaff response shapes remain.
- Cancelled orders still follow the previous Phase 1 active-order rule.
- ServicePoint enrichment remains tenant-scoped.
- Restaurant and bar/lounge businesses with `foodService` render the existing
  analytics design.
- Hybrid hotels with `lodging` and `foodService` render the food-service
  analytics module in Phase 1.

## Lodging-only handling

A business whose `capabilities.analytics.sections` contains `lodging` but not
`foodService` receives a clear temporary Phase 1 lodging-unavailable state.
It does not issue a food analytics request and does not render food-specific
cards, charts, or tables.

No hotel metrics, occupancy calculations, reservation charts, hotel cards,
lodging service, or modular v2 response contract were implemented.

## Tests and verification

### Added backend tests

- Range resolution:
  - today
  - yesterday
  - 7 days
  - this month
  - custom
  - invalid custom ranges
- Thin controller authenticated tenant scoping and error handling
- Flat DTO orchestration
- Paid and unpaid orders
- Current cancelled-order behavior
- Tips
- Preparation time
- Top items and categories
- Order type and ordering channel
- Service requests
- ServicePoint performance and tenant-scoped enrichment
- Waitstaff performance
- Cross-tenant exclusion
- Empty range response

The focused analytics and capability suites pass: 23 tests passed.

The frontend has no installed test runner or test dependencies. Phase 1 was
therefore verified with `npx tsc --noEmit` and static boundary checks confirming
that the page has no Axios orchestration, `/owner/orders` is absent from the
analytics flow, and capability sections control module rendering.

The repository advertises an ESLint script but has no pinned ESLint dependency
or usable ESLint configuration. A scoped lint attempt could not run without
changing project tooling, so no tooling changes were introduced.

## Defects discovered but not fixed

- The historical active-order calculation counts cancelled orders as active.
- `yesterdayRevenue` and `previousAverageOrderValue` remain zero placeholders,
  so comparison badges do not represent a separately queried comparison range.
- Analytics still use the existing process-wide business timezone and rollover
  rather than a tenant-specific timezone.
- Analytics retain the existing decimal monetary-field calculations rather
  than introducing an integer-cents migration, which was explicitly outside
  this extraction.
- ServicePoint performance revenue retains the historical inclusion of both
  paid and unpaid orders in its aggregation.
- The adjacent pre-existing
  `ownerServicePointDisplay.test.js` transaction assertion still fails because
  an order transaction lacks the expected `servicePointId`. That failure was
  present before this extraction and transaction logic is explicitly outside
  this task's scope.

These defects were not corrected because Phase 1 is an extraction and boundary
cleanup with behavior preservation.

## Line removal summary

- `app/owner/analytics/page.tsx`: 1,000 net lines removed
  (1,112 lines before, 112 after).
- `src/controllers/ownerController.js`: 649 lines deleted for the monolithic
  analytics block. Four model imports needed by remaining functions were moved
  to the top, so the file's net reduction is 645 lines
  (1,367 lines before, 722 after).

## Compatibility confirmation

- API path: unchanged
- API response: unchanged flat shape
- Restaurant analytics: visually and functionally preserved
- Bar/lounge analytics: visually and functionally preserved through
  `foodService`
- Hybrid hotel food analytics: preserved through `foodService`
- Lodging-only hotel: temporary clear unavailable state; no food dashboard
- Hotel analytics implemented: no
