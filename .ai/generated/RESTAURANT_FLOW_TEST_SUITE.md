# Executive Summary

QuickServe now has a dedicated restaurant-flow command:

```text
npm run test:restaurant-flow
```

The command runs 41 isolated tests: 32 restaurant lifecycle tests plus 9
receipt/webhook tests. It covers the public dine-in and takeout paths,
authoritative pricing, ServicePoint/guest-session security, kitchen/bar/waiter
routing, lifecycle transitions, offline and online payment flows, receipt
delivery/retry behavior, realtime isolation, history/reorder, authorization,
and critical cross-tenant attacks.

The final restaurant-flow run passed 41/41 tests. No real Stripe, Resend, Redis,
or MongoDB service is contacted.

# Existing Test Infrastructure Reused

- Test framework: Node's built-in `node:test` runner with
  `node:assert/strict`.
- Database strategy: controller/service tests replace Mongoose model methods
  with deterministic in-memory documents. The repository did not have a test
  database harness, so the suite follows the existing no-database pattern.
- Isolation/cleanup: `t.mock.method` restores model/provider methods after each
  test. Each test creates fresh fixture state; registered SSE clients are
  explicitly closed.
- Fixture strategy: reusable business, ServicePoint, menu item, guest session,
  order, PendingCheckout, plan, request, response, and staff-session factories
  live in `test/helpers/restaurantFlowFixtures.js`.
- Stripe mocking: checkout receives an injected test client through Express
  app locals; webhook tests mock Stripe signature construction. No Stripe
  network request is made.
- Email mocking: the existing Resend path is exercised through a mocked
  `fetch`; rendered receipt HTML, provider acceptance/failure, and idempotency
  headers are asserted.
- Realtime mocking: the production in-process SSE fallback is exercised with
  registered fake clients. Redis transport itself is outside this suite.
- Existing shared logic: `pricingService`, `inventoryService`, `orderDTO`,
  `orderEstimate`, authentication middleware, SSE manager, receipt renderer,
  email service, and webhook flow are reused.

# Suite Boundaries

The suite owns the food-order lifecycle and its integration with shared
pricing, payment, receipt, session, inventory, authorization, and realtime
infrastructure.

It does not duplicate the pricing suite's low-level formula matrix or the
capabilities suite's business-module permutations. Hotel reservations and
hotel check-in remain in their existing suites. Full Redis transport,
real-provider delivery, and live MongoDB index/transaction behavior are not
integration-tested here.

# Scenarios Covered

- Scenario A: public dine-in order, canonical offline pricing, kitchen routing,
  waitstaff cash confirmation, paid state, staff attribution, and receipt.
- Scenario B: online checkout snapshot, mocked Stripe session, verified
  webhook, paid final order, and one receipt.
- Scenario C: mixed food/drink order split to kitchen and bar while waitstaff
  and the owning customer receive the full order.
- Scenario D: manipulated business, ServicePoint, and menu identifiers are
  rejected without an Order or PendingCheckout.
- Scenario E: webhook replay leaves one final order and one receipt.
- Public business configuration and public menu availability.
- Dine-in/takeout feature gating.
- Quantity, availability, stock, notes, and allergy handling.
- Sequential status transitions, terminal states, payment-before-completion,
  timestamps, and atomic conflict responses.
- Customer history, order ownership, and current-price reorder data.
- Database, Stripe, and email failure/recovery boundaries.

# Pricing Integration

Offline public and waitstaff orders now use the existing
`calculateOfflinePricing` service. Online checkout continues to use
`calculateOnlinePricing`.

Integration assertions verify:

- persisted menu price overrides client price;
- subtotal, tax, customer-facing fee, settlement fee snapshot, and total;
- integer-cent commission/gross values;
- the business currency overrides client currency;
- PendingCheckout and Stripe line-item totals agree;
- webhook amount and currency validation;
- the offline create response returns the safe shared customer pricing
  projection with tip and currency;
- customer-facing data does not rely on client totals.

The 15-test pricing suite remains the owner of detailed formula and rounding
permutations.

# ServicePoint and Guest Session Coverage

- Active tenant-owned ServicePoint creates a guest session.
- ServicePoint label/code are preserved for customer display.
- Disabled and cross-tenant ServicePoints are rejected.
- Suspended/archived businesses cannot bootstrap a session or order.
- Guest-session expiry, ServicePoint binding, first-device atomic binding, and
  another-device rejection are covered.
- Client `businessId` is ignored after a guest session or staff session
  establishes the authoritative tenant.
- Takeout retains the current product rule that an order remains associated
  with a ServicePoint.

# Order Creation Coverage

- Exactly one Order is created for a valid request.
- Public order ID, businessId, ServicePoint, order type, source, initial status,
  ETA, and UTC `Date` values are persisted.
- Items, current prices, quantities, notes, allergies, category, preparation
  destination, and pricing are snapshotted.
- Client payment state, totals, prices, currency, and tenant identifiers do not
  override backend state.
- Zero, negative, fractional, missing, and non-numeric quantities are rejected.
- Unavailable and insufficient-stock items are rejected at checkout.
- Database creation failure returns an error without a persisted Order.

# Routing Coverage

- Kitchen-only payloads contain food items only.
- Bar-only payloads contain drink items only.
- Mixed orders publish independently targeted kitchen and bar events.
- Waitstaff and the owning customer receive the full order.
- Queue queries derive `businessId` from staff sessions.
- Another business receives neither queue data nor realtime events.

# Lifecycle Coverage

The current order state machine is:

```text
placed -> in_progress -> ready -> completed
```

Tests cover valid progression, ready/completed timestamps, invalid skipping,
backward transitions, unpaid offline completion, completed/cancelled terminal
states, cross-tenant updates, and HTTP 409 on an atomic transition conflict.

# Offline Payment Coverage

- Offline/unpaid state at creation.
- Billing and offline-channel availability gates.
- Cash and POS preference enforcement.
- Waitstaff/manager/owner role boundary through existing middleware.
- Session-derived tenant scoping.
- `paidAt`, `paidVia`, `paidByStaffId`, and `paidByName`.
- Idempotent repeat confirmation.
- Receipt send only when an email exists.
- Provider failure leaves the Order paid and does not stamp receipt delivery.
- Successful receipt uses the stable order receipt idempotency key.

# Online Payment Coverage

- Tenant/session/item/ServicePoint validation before PendingCheckout.
- Canonical item price, quantity, tax, fee, total, and business currency.
- Stripe Checkout line items, metadata, destination account, application fee,
  customer email, success URL, and cancel URL.
- Mock-only Stripe calls.
- Signature rejection before model access.
- Paid status, amount, and currency validation.
- Missing PendingCheckout behavior.
- Final paid Order fields, Checkout Session ID, PaymentIntent ID, and paid time.
- Replay idempotency: one final Order and one receipt.
- Stripe session creation failure and TTL-backed pending cleanup boundary.

# Receipt Coverage

- Existing food receipt template is reused.
- Business name, order ID, item/quantity, notes/allergies, subtotal, tax,
  service fee, total, currency, payment method/status, and ServicePoint label
  render through the existing receipt infrastructure.
- Online success and offline confirmation trigger the existing sender.
- Correct recipient and stable provider idempotency key are asserted.
- Provider rejection is surfaced.
- A paid order with a missing receipt marker can retry.
- Duplicate webhook processing does not duplicate delivery.

Modifier rendering is deferred because the current MenuItem, Order, and
PendingCheckout schemas do not represent modifier groups/options.

# Tenant Isolation Coverage

Business A cannot:

- bind a Business B ServicePoint to its guest session;
- order a Business B item through a supplied item/business identifier;
- create an Order or PendingCheckout under a client-supplied tenant;
- receive Business B kitchen/bar/waiter events;
- read Business B order history or order details;
- update or mark a Business B order paid;
- reorder another guest session's order.

All tested staff mutations derive tenant identity from the authenticated
session.

# Authorization Coverage

- Public customers are limited to public ordering/history operations.
- Unauthenticated internal middleware requests return 401.
- Kitchen is denied waitstaff payment permission.
- Staff tenant identity comes from the session, not request data.
- SSE role spoofing is pinned to the authenticated staff role.
- Cross-business staff access resolves no target Order.

# Files Created or Changed

Created for this work:

- `.ai/generated/RESTAURANT_FLOW_DEFECTS.md`
- `.ai/generated/RESTAURANT_FLOW_TEST_SUITE.md`
- `src/utils/restaurantOrderValidation.js`
- `test/helpers/restaurantFlowFixtures.js`
- `test/restaurantFlow.test.js`

Changed for the focused, test-proven fixes:

- `package.json`
- `src/controllers/kitchenController.js`
- `src/controllers/menuController.js`
- `src/controllers/orderController.js`
- `src/controllers/paymentController.js`
- `src/controllers/waitstaffOrdersController.js`
- `src/routes/guest-session-route.js`
- `src/routes/qr-route.js`
- `test/orderReceiptFlow.test.js`

Relevant receipt/webhook work already present in the working tree at the start
was preserved and reused:

- `emails/ReceiptEmail.js`
- `src/controllers/webhookController.js`
- `src/utils/emailService.js`
- `test/orderReceiptFlow.test.js`

# Test Commands

```text
npm run test:restaurant-flow
npm run test:pricing
npm run test:capabilities
npm run test:hotel-flow
npm run test:check-in
npm exec tsc -- --noEmit
npm exec tsc -- --noEmit --allowJs --checkJs false --ignoreDeprecations 6.0
git diff --check
```

There is no configured ESLint dependency or lint script. The repository's
generic `npm test` remains its pre-existing placeholder and was not changed.

# Test Results

- `npm run test:restaurant-flow`: PASS, 41/41.
- `npm run test:pricing`: PASS, 15/15.
- `npm run test:capabilities`: PASS, 9/9.
- `npm run test:hotel-flow`: PASS, 18/18.
- `npm run test:check-in`: PASS, 7/7.
- Repository-default TypeScript command: FAILS before checking source because
  the config has no TypeScript inputs and TypeScript 6 flags the legacy
  `moduleResolution=node` setting.
- JavaScript-aware TypeScript fallback
  (`--allowJs --checkJs false --ignoreDeprecations 6.0`): PASS.
- `git diff --check`: PASS; Git reports only expected LF-to-CRLF checkout
  warnings.
- Lint: NOT RUN because no lint script or ESLint installation exists.
- Frontend typecheck: NOT RUN because no frontend files were changed by this
  backend task.

# Deferred Coverage

- Modifier groups/options and required-modifier validation: no current schema.
- Hidden/active category distinction: no current category entity/visibility
  field.
- Independent kitchen and bar preparation state plus aggregate-ready
  computation: current Order has one status field.
- Duplicate public submission idempotency: no request idempotency-key contract.
- Takeout pickup-detail snapshot: no current fields.
- Configurable maximum quantity: no current business/menu limit; the suite
  enforces positive safe whole numbers.
- Disabled staff invalidation after an already-established session: current
  middleware does not reload staff state per request.
- Full Redis transport and reconnect behavior: belongs in a dedicated realtime
  integration suite.
- Live MongoDB unique-index, TTL timing, and transaction behavior.
- Real Stripe and email-provider integration.

# Failures or Unverified Areas

The first pre-fix restaurant run passed 20 tests and failed 16, reproducing the
defects recorded in `RESTAURANT_FLOW_DEFECTS.md`. The final run has no failing
restaurant scenarios.

The repository's default TypeScript configuration remains unsuitable for a
direct source typecheck, and lint tooling is absent. Those infrastructure
limitations were not changed as part of the restaurant flow.

When Stripe session creation fails after PendingCheckout persistence, the
record remains without a Stripe session and relies on the existing one-hour TTL
for cleanup. No impossible paid Order is created, but eager cleanup could be a
future hardening improvement.
