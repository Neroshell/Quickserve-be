# QuickServe Owner Analytics Phase 2 Implementation

## Outcome

Phase 2 replaces the legacy flat owner analytics DTO with contract version 2
while retaining the existing `GET /owner/analytics` route. Food-service
analytics remain available to restaurants, bars/lounges, and hybrid hotels
with `foodService`. Lodging analytics were not implemented.

The server is authoritative for analytics module enablement. A lodging-only
hotel receives valid v2 metadata with `enabledAnalyticsModules: ["lodging"]`,
an empty `modules` object, no `shared` financial block, and no food-service
database queries.

## Contract

The endpoint now returns:

- `contractVersion: 2`
- the resolved tenant-local range and its UTC boundaries
- an equal or explicitly defined prior comparison range
- the tenant currency
- `generatedAt`
- server-resolved `enabledAnalyticsModules`
- shared paid financial facts when a payable module is calculable
- `modules.foodService` only when food service is enabled

No `modules.lodging` property or placeholder lodging data is returned in
Phase 2.

## Time and range semantics

- The Business timezone is authoritative.
- Missing or invalid IANA timezone values fall back to `UTC`.
- Food-service business days roll over at 02:00 local time.
- Current and comparison boundaries are created independently as local
  instants, then converted to UTC. This avoids fixed 24-hour assumptions
  across daylight-saving transitions.
- `today`, `yesterday`, `7days`, and custom ranges compare with the
  immediately preceding equal number of local business days.
- `thisMonth` compares month-to-date with the equivalent elapsed portion of
  the previous month. The comparison end is clamped to the previous month's
  final day when the previous month is shorter.
- Custom dates must be valid `YYYY-MM-DD` local dates, `from` must not be
  after `to`, and the inclusive range is limited to 366 days.
- API date buckets are local ISO dates; instant boundaries are ISO UTC
  timestamps.

## Money and revenue semantics

- Every response field ending in `Cents` is an integer minor-unit value.
- `shared.paidRevenue.grossCents` is the total collected from paid food
  transactions, including the persisted transaction components charged to
  the customer.
- Persisted `grossAmount` is used when available because it is the validated
  minor-unit payment amount.
- Paid offline or historical orders without `grossAmount` use the exact
  persisted order `total`, rounded once to cents.
- Revenue recognition uses `paidAt`. A paid record missing `paidAt` uses its
  persisted `createdAt` as the explicit fallback.
- Unpaid transactions do not contribute to revenue.
- `netToBusinessCents` is returned only when every included paid transaction
  has a reliable persisted `netToBusinessAmount`; otherwise it is `null`.
- Tips remain included in gross collected and are also exposed separately in
  `modules.foodService.tips` for operational reporting.
- Shared revenue is assembled once. In Phase 2 its only calculated module
  contribution is `foodService`, preventing double counting.
- A paid cancelled order remains a shared financial fact because the current
  Order model has no persisted refund/reversal state. Cancelled orders are
  excluded from operational food-service metrics.

## Comparison semantics

Revenue and average-transaction comparisons use actual prior-period
aggregates:

- both current and prior values zero: `0`
- prior value non-zero: the real percentage change
- prior value zero and current value positive: `null`

The API and UI no longer fabricate a `100%` comparison for growth from zero.

## Food-service status semantics

- Active orders: `placed`, `in_progress`, and `ready`
- Completed orders: `completed`
- Cancelled and unknown states: excluded from active/completed operational
  metrics
- Service-point revenue: paid orders only
- Service-point order counts: retain paid and unpaid counts separately

`ready` is active because the order has not yet completed service or
collection.

## Query strategy and isolation

- Every analytics aggregation begins with a tenant-scoped
  `{ businessId }` match.
- The shared financial query uses one Order aggregation with facets for the
  current summary, comparison summary, daily revenue, and hourly paid facts.
- The food-service query uses one Order aggregation with facets and one
  ServiceRequest aggregation with facets.
- Service-point metadata is enriched with one tenant-scoped ServicePoint
  lookup, only when service-point identifiers exist.
- Lodging-only requests return before shared or food-service aggregation.
- Order indexes were added for:
  - `{ businessId, paymentStatus, paidAt }`
  - `{ businessId, createdAt, status }`
- A ServiceRequest `{ businessId, createdAt }` index supports the bounded
  service-request aggregation.

## Corrected defects

- Cancelled orders are no longer counted as active.
- `ready` is explicitly and consistently classified as active.
- Revenue comparisons are based on a real preceding range or `null`.
- Unpaid service-point totals no longer inflate paid revenue.
- Monetary API fields are consistently named and returned in integer cents.
- Category percentages are based on actual paid item revenue.
- The frontend no longer adds a fabricated `Remaining` category.
- Shared financial cards are rendered once; the food overview focuses on
  operational metrics.
- The analytics page no longer makes a separate business-settings request.
- The frontend does not hardcode currency and formats API cents using the
  response currency.

## Changed backend files

- `src/controllers/ownerAnalyticsController.js`
- `src/models/order.js`
- `src/models/ServiceRequest.js`
- `src/services/analytics/analyticsRangeService.js`
- `src/services/analytics/sharedAnalyticsService.js`
- `src/services/analytics/foodServiceAnalyticsService.js`
- `src/services/analytics/ownerAnalyticsService.js`
- focused analytics controller/service/range regression tests under `test/`

## Changed frontend files

- `app/owner/analytics/page.tsx`
- `hooks/use-owner-analytics.ts`
- `types/owner-analytics.ts`
- `components/analytics/shared/SharedAnalyticsSummary.tsx`
- `components/analytics/food-service/FoodServiceAnalytics.tsx`

No unrelated owner page and no canonical `.ai/approved/` file was modified.

## Verification

- Backend focused analytics and capability suite: 40 tests passed.
- Existing restaurant/order-receipt regression suite: 42 tests passed.
- Backend modified implementation files: `node --check` passed.
- Frontend: `npx tsc --noEmit` passed.
- Frontend: `npm run build` passed, including `/owner/analytics`.
- Focused ESLint could not run because the frontend uses ESLint 10 without an
  `eslint.config.js`, `eslint.config.mjs`, or `eslint.config.cjs` file. No
  lint configuration was introduced as part of this scoped change.
