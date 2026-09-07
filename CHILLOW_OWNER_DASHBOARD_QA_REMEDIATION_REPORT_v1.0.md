# Chillow Owner Dashboard QA Remediation Report v1.0

Date: 2026-09-07  
Scope: Owner Dashboard remediation only  
Repositories: `Quickserve-be` and sibling `Quick-serve-qr-menu`

## Executive summary

- Fixed 16 in-scope findings: OWNER-QA-001, 002, 003, 005–013, and 016–019.
- OWNER-QA-004 remained excluded as directed. No offline-payment availability, billing-method, or payment-availability behavior was changed.
- OWNER-QA-014 and OWNER-QA-015 were investigated without changing their product semantics and require Founder decisions.
- Reconciliation routing was confirmed as intentional shared, role-aware architecture; it was not redesigned.
- One additional issue was found and fixed: Feedback's range selector caused document-level mobile overflow.
- No commits, deployments, migrations, or production-data writes were performed. Database investigation was read-only.

## Status summary

| ID | Status | Outcome |
|---|---|---|
| OWNER-QA-001 | Fixed | Owner analytics now uses the tenant's actual operating hours; reservations no longer trust a client-authored “today.” |
| OWNER-QA-002 | Fixed | Feedback uses selected-period evidence and shows an insufficient-data state instead of invented claims. |
| OWNER-QA-003 | Fixed | Confirmed legitimate journey/visit population differences and added an explicit owner-facing explanation. |
| OWNER-QA-004 | Excluded | Intentionally untouched. |
| OWNER-QA-005 | Fixed | Orders, Transactions, Service Points, and Analytics no longer overflow at 320/375/390px. |
| OWNER-QA-006 | Fixed | Inventory drawer Close works at touch width. |
| OWNER-QA-007 | Fixed | Recipe Cancel closes and discards unsaved edits. |
| OWNER-QA-008 | Fixed | Clearing an Orders search restores the current range/filter dataset. |
| OWNER-QA-009 | Fixed | Reservation lists default to explicit reservation-date/time descending order. |
| OWNER-QA-010 | Fixed | “Active” presence wording was replaced with “online.” |
| OWNER-QA-011 | Fixed | Branding preview hydrates real business/menu/currency data. |
| OWNER-QA-012 | Fixed | Owner-visible technical/internal language was removed or replaced. |
| OWNER-QA-013 | Fixed | Health labels are normalized from deterministic evidence, including insufficient data and adverse trends. |
| OWNER-QA-014 | Requires Founder Decision | Current €51.98 result is mathematically consistent with code, but product meaning/copy need a decision. |
| OWNER-QA-015 | Requires Founder Decision | Dashboard counts all 15 records; Menu shows 7 active, unarchived records. KPI meaning needs a decision. |
| OWNER-QA-016 | Fixed | Important switches, icon actions, navigation, logo upload, and reservation inputs received accessible names. |
| OWNER-QA-017 | Fixed | Order details show authoritative subtotal/tax/platform fee/tip/total fields without frontend recomputation. |
| OWNER-QA-018 | Fixed | Shared pluralization/quantity formatting and copy corrections were applied. |
| OWNER-QA-019 | Fixed | Transactions uses neutral skeletons until the business currency is available. |

## Detailed remediation

### OWNER-QA-001 — Inconsistent “Today” calculations

- Root cause: `ownerAnalyticsService` loaded timezone but omitted `operatingHours`. The shared resolver therefore fell back to its default 22:00 close instead of Jules Corner's configured Sunday close of 23:06. Analytics incorrectly included four Sep 6 orders in Sep 7.
- Evidence: Europe/Malta Sep 7 starts at `2026-09-06T21:06:00.000Z` under the stored hours. The four orders were created at approximately 20:18–20:39Z and totalled €86.36, so they belong to Sep 6. Dashboard, Orders, Transactions, Feedback, and corrected Analytics consequently show zero for Sep 7.
- Fix: included `operatingHours` wherever analytics snapshots/ranges load Business; kept IANA timezone/DST resolution in the shared resolver. Reservation statistics now derive the business day server-side and ignore `clientToday`; the client-local date remains calendar-display-only.
- Files: `src/services/analytics/ownerAnalyticsService.js`, `src/services/analytics/weeklyAnalystSnapshotService.js`, `src/controllers/reservationController.js`, `components/reservations/dashboard/useReservationDashboard.ts`, `test/analyticsRangeService.test.js`, `test/ownerAnalyticsService.test.js`.
- Tests/regression: coverage includes midnight rollover, Malta configured closing time, spring-forward/fall-back DST, Today, Yesterday, 7/30-day and custom ranges, and lodging calendar-day isolation. Manual Analytics retest showed €0.00 and 0 paid transactions for Sep 7.
- Remaining risk: changing operating hours can still place separately persisted journey and paid-order projections on adjacent dates; OWNER-QA-003 now explains this rather than falsifying equivalence.

### OWNER-QA-002 — AI Feedback with zero supporting reviews

- Root cause: the Feedback page rendered hard-coded “amazing pasta/friendly staff/long waits” claims. Separately, the weekly analyst snapshot destructured a feedback result without scheduling a feedback query, leaving the AI evidence field undefined.
- Fix: removed fabricated claims; the selected range now displays its real review count and either an honest “not enough feedback” state or a notice that automated theme analysis is not enabled. The weekly snapshot now aggregates tenant-scoped Feedback using the same operational range supplied to analytics and passes that evidence into the analyst payload.
- Files: `app/owner/feedback/page.tsx`, `src/services/analytics/weeklyAnalystSnapshotService.js`, `test/ownerAnalyticsService.test.js`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: source contract and selected-range aggregation tests pass. In-browser Today retest showed 0 reviews, the insufficient-data message, and none of the fabricated phrases.
- Regression checks: non-empty ranges still show real review counts and recent reviews; no review text is generated from an empty dataset.
- Remaining risk: full AI theme generation remains intentionally unavailable; the UI says so explicitly.

### OWNER-QA-003 — CRM metrics contradict each other

- Root cause: the figures represent different durable populations, not projection loss. Ordering journeys are anchored to the business day when a menu visit begins. Confirmed visits/revenue are anchored to the paid order's business day after processing.
- Evidence: the mismatched €27.78 order had a Sep 7 journey date but a valid Sep 6 GuestVisit ledger row (`spendCents=2778`). For Sep 6 the read-only diagnostic found 6 journeys/6 ordered journeys, versus 2 confirmed visits containing 5 paid orders and €105.05. The examined ledger record exists; this is not a missing async projection.
- Fix: added a visible explanation when journey activity exists but confirmed-visit totals are zero, including the near-closing-time adjacent-period case.
- Files: `components/owner/crm/CrmOverview.tsx`, `components/owner/crm/CustomerVisitsChart.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: copy contract test passes; data was traced across CustomerJourney, GuestVisit, and order records without writes.
- Remaining risk: the numbers intentionally may differ. A future product decision could choose a single anchor, but that would be a semantic/data-model change rather than this UI remediation.

### OWNER-QA-004 — Offline-payment state contradiction

- Status: Excluded by assignment.
- Changes/tests: none. Offline-payment availability/configuration and billing-card behavior were not changed.

### OWNER-QA-005 — Mobile core-screen overflow

- Root cause: desktop tables and the Analytics range/header flex layout imposed widths larger than the viewport.
- Fix: Orders, Transactions, and Service Points now use priority mobile cards while retaining desktop tables at `md+`; Analytics contains horizontal range scrolling inside the component and prevents document overflow. Important identity, amount, status, and primary actions remain visible.
- Files: `app/owner/orders/page.tsx`, `app/owner/transactions/page.tsx`, `app/owner/service-points/page.tsx`, `components/analytics/shared/AnalyticsRangeSelector.tsx`, `components/analytics/shared/AnalyticsShell.tsx`, `components/analytics/shared/AnalyticsHeader.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: signed-in browser checks at 320, 375, and 390px found no document-level overflow on all four screens. Mobile cards displayed real order/transaction/service-point identity, status, amount, and actions.
- Regression checks: desktop tables remain available at `md+`; production build passed.
- Remaining risk: none identified for the four assigned screens.

### OWNER-QA-006 — Inventory drawer Close button

- Root cause: the close control sat below the drawer's sticky header stacking layer and did not receive the intended touch/click.
- Fix: raised the shared Sheet close button above the sticky content.
- Files: `components/ui/sheet.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: opened Chicken at 390px, activated Close, and confirmed the dialog count returned to zero. Escape behavior remains provided by Radix.
- Remaining risk: shared Sheet stacking changed globally; related inventory and navigation surfaces were regression-checked.

### OWNER-QA-007 — Recipe editor Cancel

- Root cause: Cancel was a plain button without a dialog-close action.
- Fix: wrapped Cancel in Radix `DialogClose`; no save/mutation is invoked.
- Files: `components/owner/inventory/RecipeBuilderDialog.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: changed Tomatoes quantity from 1 to 2 without saving, cancelled, reopened, and confirmed it remained 1.
- Remaining risk: none identified.

### OWNER-QA-008 — Orders search clear

- Root cause: clearing relied only on state/effect timing, while an older zero-result request could race with the restored query/pagination state.
- Fix: added a visible accessible clear action, reset to the first cursor page, and guarded state commits with request sequencing.
- Files: `app/owner/orders/page.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: Last 7 Days showed 25 rows; a no-match query showed 0; clearing restored the first order and “Showing 25 of up to 25.” Cursor/SSE recovery tests still pass.
- Remaining risk: none identified.

### OWNER-QA-009 — Reservation ordering

- Root cause: the shared dashboard list defaulted to creation order, which is not predictable operational ordering.
- Fix: defaults to reservation date/time descending. The backend's existing `sortDate = checkInDate ?? date` and `sortTime` cursor ordering supports both lodging and restaurant reservations.
- Files: `components/reservations/dashboard/useReservationDashboard.ts`, `components/reservations/HotelReservationsDashboard.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: static contract verifies date-desc defaults and server parameters; TypeScript/build pass. Clear Filters restores the same explicit order.
- Remaining risk: legacy `reservation-arrival-ui.test.mjs` contains a stale source-regex assertion unrelated to this ordering change; see Pre-existing failures.

### OWNER-QA-010 — Staff “active” wording

- Root cause: account enablement and real-time presence were conflated in owner copy.
- Fix: zero-presence states now say “No staff are currently online” and the dashboard badge says “0 online.”
- Files: `src/controllers/ownerController.js`, `app/owner/dashboard/page.tsx`.
- Tests/manual: Dashboard/staff copy reviewed; no account-status logic changed.
- Remaining risk: presence depends on the existing session heartbeat and was not redesigned.

### OWNER-QA-011 — Branding preview

- Root cause: the preview used generic business/menu content and a hard-coded dollar price.
- Fix: the tenant-scoped branding endpoint returns business name/currency and the newest active, unarchived, available MenuItem; the preview renders that data or an honest empty state.
- Files: `src/controllers/ownerController.js`, `app/owner/branding/page.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: browser showed Jules Corner, Indomie, and €4.00. Static checks reject “Signature Burger” and `$14.99`.
- Remaining risk: the preview intentionally shows one representative available item, not the entire menu.

### OWNER-QA-012 — Remove technical language

- Root cause: internal storage/API terminology and developer-only payment configuration text leaked into owner surfaces.
- Fix: replaced canonical/server/immutable-record wording in Inventory, removed internal IDs from Settings/Inventory/Service Points, changed staff API wording, and replaced Stripe environment/server and email server-error messages with owner-facing support guidance.
- Files: `components/owner/inventory/InventoryItemDrawer.tsx`, `components/owner/inventory/InventoryItemFormDialog.tsx`, `components/owner/inventory/InventoryMovementDialog.tsx`, `components/owner/inventory/RecipeBuilderDialog.tsx`, `app/owner/settings/page.tsx`, `app/owner/service-points/page.tsx`, `app/owner/staff/page.tsx`, `components/owner/billing/AddPaymentMethodModal.tsx`, `app/owner/confirm-email/page.tsx`.
- Tests/manual: owner-facing source scan now finds the target terms only in comments, variable names, or customer-facing pricing implementation internals—not rendered owner copy.
- Remaining risk: repository comments retain technical vocabulary by design.

### OWNER-QA-013 — AI Business Analyst health labels

- Root cause: model-generated labels were trusted as authoritative even when deterministic insights or domain evidence showed warnings/no data.
- Fix: added a deterministic health normalizer. Insufficient domains become `Insufficient data`; warning evidence becomes `Watch`/`Strained`; `Healthy` requires positive evidence; adverse metric fallbacks cover trends excluded by insight ranking. Normalization runs both before persistence and when reading existing reports.
- Files: `src/services/ai/businessHealthNormalizer.js`, `src/services/ai/weeklyAnalystGenerationService.js`, `src/controllers/ownerAnalystReportController.js`, `src/services/analytics/weeklyAnalystSnapshotService.js`, `test/ownerAnalyticsService.test.js`.
- Tests/manual: tests cover unsupported Healthy labels, warning severity, insufficient overall data, zero-feedback evidence, and a returning-customer decline excluded from ranked insights. Existing report retest showed Sales `WATCH` and Customer feedback `INSUFFICIENT DATA` rather than false Healthy states.
- Remaining risk: status semantics are deterministic but intentionally coarse; Founder/product may later rename `Watch`/`Strained`.

### OWNER-QA-014 — Pending invoice composition

- Status: Requires Founder Decision. Billing semantics were not changed.
- Current calculation location: `src/controllers/billingController.js`, especially the offline fee breakdown around lines 108–147 and billing response around lines 1704–1758.
- Exact contributors in the tested state:
  - customer-paid offline QuickServe fees: €35.29;
  - business-paid offline QuickServe fees: €16.69;
  - total offline QuickServe fees: €51.98;
  - subscription: €0.00;
  - other included amounts: none;
  - pending invoice: `subscriptionFee + totalQuickServeFees = €51.98`.
- Mathematical conclusion: the displayed €51.98 is correct for the implemented formula. `offlineCommissionAmount` also equals all offline QuickServe fees, not only business-paid fees.
- Product/copy conclusion: if “Pending Invoice” is intended to recover every QuickServe fee on offline-paid orders, the number is correct and the explanation must explicitly include customer-paid and business-paid fees. If it is intended to invoice only business-absorbed fees, the formula is wrong and should be €16.69 plus subscription. Founder must choose before a change.
- Tests/manual: read-only order/billing breakdown reconciliation; no mutations or payment behavior changes.
- Remaining risk: ambiguous owner copy can make a correct formula appear incorrect.

### OWNER-QA-015 — Dashboard menu count and Reconciliation route

- Status: Requires Founder Decision. Counts/routes were not arbitrarily changed.
- Menu evidence:
  - all MenuItem records: 15;
  - active, unarchived records: 7;
  - archived records: 8;
  - unarchived unavailable records: 0.
- Code definitions: Dashboard uses `MenuItem.countDocuments({ businessId })` in `src/controllers/ownerController.js`; Menu filters `archivedAt: null` and its owner result includes the 7 unarchived records in `src/controllers/menuController.js`.
- Recommendation: label the owner KPI “Active menu items” and define it as unarchived + available/sellable (7 for this dataset). If historical catalog size is valuable, expose it separately as “All menu records”; do not call 15 simply “Menu Items.”
- Reconciliation evidence: Dashboard intentionally links to `/waitstaff/past-orders?range=7days`. The page guard admits waiter/manager/owner/co-owner; backend routes explicitly label these as reconciliation routes, require those roles, require `ORDERS_VIEW` for reads, and `ORDERS_MANAGE` for mutations.
- Reconciliation conclusion: this is intentional shared, role-aware UI/architecture, not accidental authorization leakage. The route name is implementation history and may warrant later owner-facing URL/navigation refinement, but no redesign was made.
- Remaining risk: the current dashboard label remains ambiguous until Founder chooses the KPI.

### OWNER-QA-016 — Accessibility

- Root cause: switches, icon-only actions, mobile navigation, refresh controls, and reservation filters lacked programmatic names; logo upload was a clickable `div`.
- Fix: added labels/ARIA state/names, marked decorative icons appropriately, named reservation search/date/status controls, and changed logo upload to a keyboard-accessible button with image alt text.
- Files: `app/owner/layout.tsx`, `app/owner/branding/page.tsx`, `app/owner/settings/page.tsx`, `app/owner/staff/page.tsx`, `app/owner/service-points/page.tsx`, `components/analytics/shared/AnalyticsHeader.tsx`, `components/reservations/RestaurantReservationsDashboard.tsx`, `components/reservations/HotelReservationsDashboard.tsx`.
- Tests/manual: browser DOM snapshots exposed names such as “Open owner navigation,” “Refresh analytics,” “Clear order search,” and Inventory “Close.” Typecheck/build pass.
- Remaining risk: lint still reports broader legacy accessibility/image warnings outside this focused pass.

### OWNER-QA-017 — Order financial breakdown

- Root cause: the owner drawer emphasized only the final total despite authoritative backend breakdown fields already being present.
- Fix: renders authoritative subtotal, tax, platform/service fee, tip, and total. The frontend formats values only and does not recalculate totals.
- Files: `app/owner/orders/page.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: source contract confirms each authoritative field; existing transaction/refund behavior was not altered.
- Remaining risk: fields absent from older orders remain omitted rather than inferred.

### OWNER-QA-018 — Copy quality

- Root cause: hard-coded singular labels and inconsistent capitalization/spelling.
- Fix: added reusable `pluralize`, reused inventory quantity formatting, and corrected portions/ingredients/service points/active customers/orders/daily copy.
- Files: `lib/localization.ts`, `app/owner/menu/page.tsx`, `app/owner/service-points/page.tsx`, `components/analytics/food-service/FoodServiceAnalytics.tsx`, `components/owner/crm/CustomerVisitsChart.tsx`, `components/owner/inventory/RecipeBuilderDialog.tsx`.
- Tests/manual: production build and UI/source regression suite pass; browser showed “6 items” and correctly pluralized inventory quantities.
- Remaining risk: copy outside Owner Dashboard was out of scope.

### OWNER-QA-019 — Currency loading state

- Root cause: monetary summary state initialized to zero before EUR settings arrived, allowing the generic formatter fallback to show `$0.00`.
- Fix: monetary cards and payment split show skeletons while loading; once loaded they use saved business currency, falling back to Business context rather than USD.
- Files: `app/owner/transactions/page.tsx`, `owner-dashboard-remediation-ui.test.mjs`.
- Tests/manual: skeleton/currency source contract passes; signed-in browser showed EUR values and no USD flash during the inspected load.
- Remaining risk: none identified.

## Additional issue found and fixed

- Feedback range selector overflowed the document at mobile width because its no-wrap button group was wider than its column. It now uses component-contained horizontal scrolling. Browser verification at 320 and 390px showed exact viewport scroll widths and no document overflow.
- File: `app/owner/feedback/page.tsx`.

## Automated verification

- Backend focused suite: **22/22 passed** — `analyticsRangeService.test.js` + `ownerAnalyticsService.test.js`.
- Frontend focused/regression suite: **29/29 passed** — remediation, owner Orders pagination, inventory lifecycle/phase 6c, and co-owner access contracts.
- Frontend production build: **passed** — Next.js 16.0.10, 37 pages generated, exit 0.
- Frontend TypeScript: **passed** — `npx tsc --noEmit`, exit 0.
- Frontend lint: **passed with warnings** — 0 errors, 170 warnings. The remaining warnings are predominantly existing unused imports/hooks and `<img>` advisories; no repo-wide warning cleanup was attempted.
- Backend syntax checks: **passed** for all changed JavaScript modules.
- Diff hygiene: `git diff --check` passed in both repositories; line-ending notices only.

## Manual verification

- Signed-in owner checks covered Dashboard/Analytics date totals, Feedback zero/non-zero periods, Branding preview hydration, Orders search-clear restoration, Inventory drawer Close, Recipe Cancel/discard, and core mobile layouts.
- Core responsive matrix: Orders, Transactions, Service Points, Analytics at 320, 375, and 390px — no document-level horizontal overflow.
- No destructive owner action, real financial transaction, production data write, commit, deployment, or migration was performed.

## Pre-existing/unrelated test and tooling issues

- `ai-business-analyst-ui.test.mjs` imports `vitest`, which is not installed.
- `reservation-arrival-ui.test.mjs` has a stale source-regex expectation for `reservation.status === "arrived"`.
- `transaction-module-ui.test.mjs` has a stale source-regex expectation for `transaction.sourceType === "reservation"` while the implementation uses `selectedTxn`.
- `test:crm-conversion-insights` references a missing `crm-conversion-insights.test.mjs` file.
- Backend `weeklyAnalystGeneration.test.js` imports missing legacy module `src/services/ai/aiPayloadBuilder.js` (the implementation uses `aiPayloadBuilderV5.js`).
- Backend `weeklyAnalystReport.test.js` contains date-dependent fixtures whose period keys no longer match their August 2026 dates when run on 2026-09-07.
- Frontend had a pre-existing modified `inventory-phase6c-ui.test.mjs`; it was not edited by this remediation and its included tests pass.
- Build emits the non-blocking `baseline-browser-mapping` data-age warning.

## Founder review actions

1. Decide whether Pending Invoice includes all QuickServe offline fees (€51.98 here) or only business-paid fees (€16.69 here), then align formula and copy.
2. Define the Dashboard menu KPI. Recommendation: “Active menu items” = unarchived and available/sellable (7 here).
3. Optionally schedule cleanup for stale test harnesses and the 170-warning lint backlog.

## Final disposition

Implementation and focused verification are complete. The Owner Dashboard remediation is ready for Founder review, with only OWNER-QA-014 and OWNER-QA-015 intentionally awaiting product decisions.
