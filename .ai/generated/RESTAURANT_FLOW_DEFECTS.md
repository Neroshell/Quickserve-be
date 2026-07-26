# Restaurant Flow Defects

This file records defects discovered while mapping the restaurant flow before
implementing any production fixes. The corresponding regression coverage lives
in `test/restaurantFlow.test.js`.

Resolution summary: RF-001 through RF-009 were fixed with focused controller
boundary changes and now have passing regression coverage. The explicitly
deferred items at the end of this document were not implemented.

## RF-001: Public offline order session lookup cannot succeed

- Area: `src/controllers/orderController.js`
- Evidence: the controller imports `GuestSession` but calls the undefined
  `TableSession` identifier. It also compares the stored `servicePointId` field
  through the obsolete `tableId` name.
- Impact: a valid guest session reaches the controller catch block and receives
  HTTP 500 instead of creating an order.
- Intended narrow fix: use the existing `GuestSession` model and canonical
  `servicePointId` field.

## RF-002: Checkout accepts unavailable items and malformed quantities

- Areas: `src/controllers/orderController.js`,
  `src/controllers/paymentController.js`,
  `src/controllers/waitstaffOrdersController.js`
- Evidence: menu lookup does not reject `isAvailable: false`; offline flows
  multiply the stored price by an unvalidated quantity; online checkout silently
  turns zero, negative, fractional, or non-numeric quantities into another
  quantity.
- Impact: an item disabled after menu load can still be ordered, and malformed
  quantities can create invalid snapshots or unexpected orders.
- Intended narrow fix: share payload validation across all restaurant order
  entry points and reject unavailable menu records before persistence or Stripe.

## RF-003: Client currency overrides business currency

- Areas: `src/controllers/orderController.js`,
  `src/controllers/paymentController.js`,
  `src/controllers/waitstaffOrdersController.js`
- Evidence: each flow accepts request `currency` as authoritative.
- Impact: an order or Stripe Checkout can be created in a currency other than
  the owning business's configured currency.
- Intended narrow fix: derive currency from the loaded `Business`.

## RF-004: Service and payment preferences are not enforced server-side

- Areas: restaurant order creation, online checkout, offline mark-paid
- Evidence: `orderingPreferences` and `paymentPreferences` exist in the
  `Business` model, but the order endpoints do not consistently enforce them.
- Impact: disabled dine-in/takeout, online/offline payment, cash, or POS options
  can still be used through direct API calls.
- Intended narrow fix: apply the existing stored preferences at the relevant
  controller boundaries.

## RF-005: A disabled ServicePoint can remain orderable

- Areas: offline and online customer checkout
- Evidence: both controllers resolve the ServicePoint label without requiring a
  tenant-owned active ServicePoint.
- Impact: a ServicePoint disabled after QR bootstrap can still receive orders.
- Intended narrow fix: require the ServicePoint to belong to the derived
  business and remain active at checkout.

## RF-006: Cancelled order transition can throw

- Areas: generic and kitchen order status controllers
- Evidence: transition code calls `.includes` on an undefined transition list
  for `cancelled`.
- Impact: attempting to progress a cancelled order returns HTTP 500 rather than
  a domain validation response.
- Intended narrow fix: treat unknown/terminal states as having no allowed next
  transitions.

## RF-007: Repeated offline payment confirmation is not idempotent

- Area: `src/controllers/orderController.js`
- Evidence: an already-paid order returns HTTP 400, and the background receipt
  path records `receiptSent` without checking the provider result.
- Impact: safe retries appear as failures; a failed provider call can suppress a
  later receipt retry.
- Intended narrow fix: return the existing paid state for repeats and only stamp
  receipt delivery after provider acceptance, using the existing order receipt
  idempotency key.

## RF-008: Public menu response exposes unavailable items

- Area: `src/controllers/menuController.js`
- Evidence: the unauthenticated list endpoint applies only `businessId`.
- Impact: disabled items remain exposed to public menu consumers.
- Intended narrow fix: filter unavailable items for public callers while
  retaining complete menu management visibility for authenticated staff in the
  owning business.

## RF-009: Offline create response omits canonical customer pricing

- Area: `src/controllers/orderController.js`
- Evidence: the endpoint persists authoritative pricing but returns only order
  ID, business ID, and status.
- Impact: the public order response cannot be verified against the shared
  customer pricing contract, and tip-inclusive totals are not projected.
- Intended narrow fix: calculate tips through the existing shared pricing
  service input and add its safe customer projection to the create response.

## Explicitly not fixed by this test task

- Modifier groups/options are not represented by the current menu or order
  schemas.
- Category visibility/activation is not represented by the current schema.
- Kitchen and bar do not have independent per-destination preparation states;
  an order currently has one aggregate status.
- Duplicate customer submission has no idempotency key contract.
- Takeout pickup-detail fields are not represented by the current order schema.

Those items require product/domain design beyond a test-suite addition and are
reported as deferred coverage rather than implemented here.
