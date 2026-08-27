import assert from "node:assert/strict"
import test from "node:test"

process.env.REDIS_URL = ""
process.env.BULLMQ_EMAILS_ENABLED = "false"
process.env.STRIPE_SECRET_KEY = "sk_test_online_journey"
process.env.STRIPE_WEBHOOK_SECRET = "whsec_online_journey"
process.env.FRONTEND_BASE_URL = "https://app.quickserve.test"

const [
  { createCheckoutSession },
  {
    handleDurableStripeWebhook,
    PAID_CHECKOUT_FULFILLMENT_STATE_MISSING,
  },
  { processCrmOrder },
  { resolveBusinessDay },
  { PENDING_CHECKOUT_RETENTION_MS },
  { default: Business },
  { default: CustomerJourney },
  { default: GuestSession },
  { default: MenuItem },
  { default: Order },
  { default: PendingCheckout },
  { default: Plan },
  { default: ServicePoint },
] = await Promise.all([
  import("../src/controllers/paymentController.js"),
  import("../src/controllers/webhookController.js"),
  import("../src/services/guestProfileService.js"),
  import("../src/utils/businessDate.js"),
  import("../src/constants/checkoutRetention.js"),
  import("../src/models/Business.js"),
  import("../src/models/CustomerJourney.js"),
  import("../src/models/GuestSession.js"),
  import("../src/models/menuItem.js"),
  import("../src/models/order.js"),
  import("../src/models/PendingCheckout.js"),
  import("../src/models/Plan.js"),
  import("../src/models/ServicePoint.js"),
])

const {
  createBusinessFixture,
  createGuestSessionFixture,
  createMenuItemFixture,
  createOrderDocument,
  createPendingCheckoutDocument,
  createPlanFixture,
  createPublicOrderRequest,
  createResponse,
  createServicePointFixture,
  mockQuery,
} = await import("./helpers/restaurantFlowFixtures.js")

const HOUR_MS = 60 * 60 * 1000
const JOURNEY_ID = `jrn_${"a".repeat(32)}`

function applyJourneyUpdate(journey, update) {
  for (const [field, value] of Object.entries(update.$addToSet || {})) {
    if (!journey[field].includes(value)) journey[field].push(value)
  }
  for (const [field, value] of Object.entries(update.$inc || {})) {
    journey[field] = Number(journey[field] || 0) + Number(value)
  }
  for (const [field, value] of Object.entries(update.$max || {})) {
    if (!journey[field] || new Date(value) > new Date(journey[field])) {
      journey[field] = value
    }
  }
  Object.assign(journey, update.$set || {})
}

function matchesJourney(journey, filter) {
  if (filter.businessId && filter.businessId !== journey.businessId) return false
  if (filter.journeyId && filter.journeyId !== journey.journeyId) return false
  if (filter.localBusinessDate && filter.localBusinessDate !== journey.localBusinessDate) return false
  if (filter.guestProfileId && filter.guestProfileId !== journey.guestProfileId) return false
  if (filter.placedOrderIds?.$ne && journey.placedOrderIds.includes(filter.placedOrderIds.$ne)) {
    return false
  }
  if (filter.paidOrderIds?.$ne && journey.paidOrderIds.includes(filter.paidOrderIds.$ne)) {
    return false
  }
  if (filter.completedAt === null && journey.completedAt) return false
  if (filter.$or) {
    const eligible = filter.$or.some((condition) => {
      const [field, expected] = Object.entries(condition)[0]
      if (expected === null) return journey[field] == null
      if (expected?.$exists === false) return journey[field] === undefined
      if (expected?.$gt) return journey[field] && new Date(journey[field]) > new Date(expected.$gt)
      return journey[field] === expected
    })
    if (!eligible) return false
  }
  return true
}

function installJourneyModel(t, journey) {
  t.mock.method(CustomerJourney, "findOne", (filter) =>
    Promise.resolve(matchesJourney(journey, filter) ? journey : null))
  t.mock.method(CustomerJourney, "findOneAndUpdate", async (filter, update) => {
    if (!matchesJourney(journey, filter)) return null
    applyJourneyUpdate(journey, update)
    return journey
  })
  t.mock.method(CustomerJourney, "updateOne", async (filter, update) => {
    if (!matchesJourney(journey, filter)) return { matchedCount: 0, modifiedCount: 0 }
    applyJourneyUpdate(journey, update)
    return { matchedCount: 1, modifiedCount: 1 }
  })
}

function createCrmRepository({ orderRef, business, profile }) {
  let ledger = null
  return {
    async claimOrder({ businessId, orderId, claimId, now }) {
      const order = orderRef.current
      if (
        !order ||
        order.businessId !== businessId ||
        order.orderId !== orderId ||
        order.crmProcessed
      ) return null
      order.crmProcessingStatus = "processing"
      order.crmProcessingClaimId = claimId
      order.crmProcessingClaimedAt = now
      order.crmProcessingAttemptCount = Number(order.crmProcessingAttemptCount || 0) + 1
      return order
    },
    async loadOrder() {
      return orderRef.current
    },
    async loadBusiness() {
      return business
    },
    async ensureLedger(contribution) {
      ledger ||= { ...contribution, status: "pending" }
      return ledger
    },
    async claimGuest() {
      return profile
    },
    async ensureProfileBaseline() {
      return {
        firstVisitAt: null,
        lastVisitAt: null,
        firstOrderId: null,
        lastOrderId: null,
        visitCount: 0,
        orderCount: 0,
        paidOrderCount: 0,
        totalSpendCents: 0,
        favouriteItems: [],
      }
    },
    async ensureVisitBaseline({ now }) {
      return {
        exists: false,
        existed: false,
        capturedAt: now,
        orderIds: [],
        paidOrderIds: [],
        spendCents: 0,
      }
    },
    async listLedgerEntries() {
      return [ledger]
    },
    async replaceProfile({ projection }) {
      Object.assign(profile, projection)
    },
    async replaceVisit() {},
    async completeLedger({ now }) {
      Object.assign(ledger, { status: "completed", completedAt: now })
    },
    async completeOrder({ claimId, now }) {
      assert.equal(orderRef.current.crmProcessingClaimId, claimId)
      Object.assign(orderRef.current, {
        crmProcessed: true,
        crmProcessedAt: now,
        crmProcessingStatus: "completed",
        crmProcessingClaimId: null,
        crmProcessingClaimedAt: null,
        crmProcessingRetryable: false,
      })
    },
    async failOrder({ error }) {
      orderRef.current.crmProcessingStatus = "failed"
      orderRef.current.crmProcessingLastError = error.message
    },
    async releaseGuest() {},
  }
}

function createDurableEventStore() {
  const events = new Map()
  return {
    events,
    async claim({ eventId }) {
      const existing = events.get(eventId)
      if (existing?.status === "processed") {
        return { claimed: false, reason: "already_processed", event: existing }
      }
      const claimId = `claim-${eventId}-${Number(existing?.attemptCount || 0) + 1}`
      const event = {
        status: "processing",
        claimId,
        attemptCount: Number(existing?.attemptCount || 0) + 1,
      }
      events.set(eventId, event)
      return { claimed: true, claimId, event }
    },
    async complete({ eventId, claimId, status, error }) {
      const event = events.get(eventId)
      assert.equal(event.claimId, claimId)
      Object.assign(event, { status, error: error || null, claimId: null })
      return { completed: status !== "failed", status }
    },
  }
}

function webhookRequest(event, locals) {
  return {
    body: Buffer.from("test-webhook"),
    headers: { "stripe-signature": "test-signature" },
    app: {
      locals: {
        ...locals,
        constructStripeWebhookEvent: () => event,
      },
    },
  }
}

test("online checkout preserves journey through webhook, CRM identification, and duplicate delivery", async (t) => {
  t.mock.method(console, "log", () => {})
  t.mock.method(console, "warn", () => {})

  const business = createBusinessFixture()
  const servicePoint = createServicePointFixture()
  const guestSession = createGuestSessionFixture()
  const menuItem = createMenuItemFixture()
  const plan = createPlanFixture()
  const localBusinessDate = resolveBusinessDay(business, new Date()).businessDay
  const journey = {
    journeyId: JOURNEY_ID,
    businessId: business.businessId,
    servicePointId: servicePoint.servicePointId,
    orderType: "dine-in",
    sessionId: "device-a",
    tableSessionToken: guestSession.token,
    localBusinessDate,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    firstOrderedAt: null,
    lastOrderedAt: null,
    identifiedAt: null,
    guestProfileId: null,
    completedAt: null,
    orderCount: 0,
    paidOrderCount: 0,
    totalSpendCents: 0,
    placedOrderIds: [],
    paidOrderIds: [],
    async save() { return this },
  }
  installJourneyModel(t, journey)

  t.mock.method(GuestSession, "findOne", () => mockQuery(guestSession))
  t.mock.method(GuestSession, "findOneAndUpdate", async () => guestSession)
  t.mock.method(Business, "findOne", () => mockQuery(business))
  t.mock.method(ServicePoint, "findOne", () => mockQuery(servicePoint))
  t.mock.method(Plan, "findOne", () => mockQuery(plan))
  t.mock.method(MenuItem, "findOne", () => mockQuery(menuItem))
  t.mock.method(MenuItem, "findOneAndUpdate", async () => null)

  let pending = null
  t.mock.method(PendingCheckout, "create", async (fields) => {
    pending = createPendingCheckoutDocument(fields)
    return pending
  })

  const stripeExpiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60
  const stripeConfigs = []
  const stripeClient = {
    checkout: {
      sessions: {
        async create(config) {
          stripeConfigs.push(config)
          return {
            id: "cs_online_journey",
            url: "https://checkout.stripe.test/online-journey",
            payment_intent: "pi_online_journey",
            expires_at: stripeExpiresAt,
          }
        },
      },
    },
  }

  const checkoutResponse = createResponse()
  await createCheckoutSession(
    {
      ...createPublicOrderRequest({
        journeyId: JOURNEY_ID,
        receiptEmail: "guest@example.com",
      }),
      app: { locals: { stripe: stripeClient } },
    },
    checkoutResponse,
  )

  assert.equal(checkoutResponse.statusCode, 201)
  assert.equal(checkoutResponse.body.journeyId, JOURNEY_ID)
  assert.equal(pending.journeyId, JOURNEY_ID)
  assert.equal(pending.stripeSessionId, "cs_online_journey")
  assert.equal(pending.stripeExpiresAt.toISOString(), new Date(stripeExpiresAt * 1000).toISOString())
  assert.equal(
    pending.expiresAt.getTime(),
    stripeExpiresAt * 1000 + 3 * 24 * HOUR_MS + HOUR_MS,
  )
  assert.equal(PENDING_CHECKOUT_RETENTION_MS, 97 * HOUR_MS)
  assert.equal(stripeConfigs.length, 1)
  assert.equal(stripeConfigs[0].expires_at, undefined)

  const orderRef = { current: null }
  t.mock.method(Order, "findOne", async (filter) => {
    const order = orderRef.current
    return order && order.businessId === filter.businessId && order.orderId === filter.orderId
      ? order
      : null
  })
  t.mock.method(Order, "create", async (fields) => {
    orderRef.current = createOrderDocument({
      ...fields,
      inventoryDeducted: true,
      receiptSent: true,
      receiptSentAt: new Date(),
    })
    return orderRef.current
  })
  t.mock.method(PendingCheckout, "findById", async () => pending)
  t.mock.method(PendingCheckout, "findByIdAndDelete", async () => {
    const deleted = pending
    pending = null
    return deleted
  })

  const profile = {
    _id: "profile-online-journey",
    businessId: business.businessId,
    email: "guest@example.com",
    guestStatus: "lead",
    visitCount: 0,
    orderCount: 0,
    paidOrderCount: 0,
    totalSpendCents: 0,
    favouriteItems: [],
  }
  const crmRepository = createCrmRepository({ orderRef, business, profile })
  let crmPromise = null
  const dispatchCrmOrder = ({ businessId, orderId }) => {
    crmPromise = processCrmOrder({
      businessId,
      orderId,
      repository: crmRepository,
      now: new Date(),
    })
    return crmPromise
  }

  const durable = createDurableEventStore()
  const baseSession = {
    id: "cs_online_journey",
    payment_status: "paid",
    amount_total: pending.grossAmount,
    currency: pending.currency.toLowerCase(),
    payment_intent: "pi_online_journey",
    customer_details: { email: "guest@example.com" },
    metadata: {
      pendingCheckoutId: pending._id.toString(),
      orderId: pending.orderId,
      businessId: pending.businessId,
    },
  }
  const event = {
    id: "evt_online_journey",
    type: "checkout.session.completed",
    data: { object: baseSession },
  }
  const locals = {
    claimStripeWebhookEvent: durable.claim,
    completeStripeWebhookEvent: durable.complete,
    dispatchAutomaticOrderReceipt: async () => ({ mode: "queued", queued: true }),
    dispatchCrmOrder,
  }

  const firstResponse = createResponse()
  await handleDurableStripeWebhook(webhookRequest(event, locals), firstResponse)
  assert.equal(firstResponse.statusCode, 200)
  assert.equal(durable.events.get(event.id).status, "processed")
  assert.ok(crmPromise)
  await crmPromise

  const order = orderRef.current
  assert.equal(order.journeyId, JOURNEY_ID)
  assert.equal(journey.orderCount, 1)
  assert.deepEqual(journey.placedOrderIds, [order.orderId])
  assert.equal(journey.paidOrderCount, 1)
  assert.deepEqual(journey.paidOrderIds, [order.orderId])
  assert.equal(journey.totalSpendCents, Math.round(order.total * 100))
  assert.ok(journey.firstOrderedAt instanceof Date)
  assert.equal(journey.guestProfileId, profile._id)
  assert.ok(journey.identifiedAt instanceof Date)

  // Process a second event for the same paid Session. This exercises the
  // Order-level and journey-array idempotency even beyond event-ID deduping.
  const duplicateEvent = {
    ...event,
    id: "evt_online_journey_duplicate",
  }
  const duplicateResponse = createResponse()
  await handleDurableStripeWebhook(
    webhookRequest(duplicateEvent, locals),
    duplicateResponse,
  )
  assert.equal(duplicateResponse.statusCode, 200)
  assert.equal(journey.orderCount, 1)
  assert.deepEqual(journey.placedOrderIds, [order.orderId])
  assert.equal(journey.paidOrderCount, 1)
  assert.deepEqual(journey.paidOrderIds, [order.orderId])
  assert.equal(journey.totalSpendCents, Math.round(order.total * 100))

  // Re-delivery of the exact same Stripe event is stopped by the durable
  // event ledger before business processing.
  const redeliveryResponse = createResponse()
  await handleDurableStripeWebhook(
    webhookRequest(duplicateEvent, locals),
    redeliveryResponse,
  )
  assert.equal(redeliveryResponse.statusCode, 200)
  assert.equal(durable.events.get(duplicateEvent.id).attemptCount, 1)
  assert.equal(journey.orderCount, 1)
  assert.equal(journey.paidOrderCount, 1)
  assert.equal(journey.totalSpendCents, Math.round(order.total * 100))
})

test("paid webhook with no PendingCheckout or Order remains failed and retryable", async (t) => {
  t.mock.method(console, "error", () => {})
  t.mock.method(PendingCheckout, "findById", async () => null)
  t.mock.method(Order, "findOne", async () => null)

  const event = {
    id: "evt_missing_paid_fulfillment",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_missing_paid_fulfillment",
        payment_status: "paid",
        amount_total: 1045,
        currency: "eur",
        metadata: {
          pendingCheckoutId: "missing-pending-id",
          orderId: "QS-MISSING-ORDER",
          businessId: "business-a",
        },
      },
    },
  }
  const durable = createDurableEventStore()
  const locals = {
    claimStripeWebhookEvent: durable.claim,
    completeStripeWebhookEvent: durable.complete,
  }

  const firstResponse = createResponse()
  await handleDurableStripeWebhook(webhookRequest(event, locals), firstResponse)
  assert.equal(firstResponse.statusCode, 500)
  assert.equal(firstResponse.body, PAID_CHECKOUT_FULFILLMENT_STATE_MISSING)
  assert.equal(durable.events.get(event.id).status, "failed")
  assert.equal(
    durable.events.get(event.id).error,
    PAID_CHECKOUT_FULFILLMENT_STATE_MISSING,
  )

  const retryResponse = createResponse()
  await handleDurableStripeWebhook(webhookRequest(event, locals), retryResponse)
  assert.equal(retryResponse.statusCode, 500)
  assert.equal(durable.events.get(event.id).status, "failed")
  assert.equal(durable.events.get(event.id).attemptCount, 2)
})
