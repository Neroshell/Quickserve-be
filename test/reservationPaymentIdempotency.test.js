import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import mongoose from "mongoose"

import {
    buildReservationPaymentAttemptFingerprint,
    buildReservationStripeIdempotencyKey,
    createOrReuseReservationCheckout,
    reconcileReservationCheckoutCompleted,
    reconcileReservationCheckoutExpired,
    ReservationPaymentAttemptError,
    validateReservationProviderSession,
} from "../src/services/reservationPaymentAttemptService.js"
import { toReservationTransaction } from "../src/services/transactionReadService.js"

function same(left, right) {
    if (left == null || right == null) return left == null && right == null
    return String(left) === String(right)
}

function matches(document, query) {
    if (!document) return false
    return Object.entries(query).every(([key, expected]) => {
        if (key === "$or") return expected.some((entry) => matches(document, entry))
        const actual = document[key]
        if (expected && typeof expected === "object" && !Array.isArray(expected)) {
            if ("$ne" in expected && same(actual, expected.$ne)) return false
            if ("$exists" in expected && (actual !== undefined) !== expected.$exists) return false
            if ("$in" in expected && !expected.$in.some((value) => same(actual, value))) return false
            const operators = Object.keys(expected).filter((entry) => entry.startsWith("$"))
            if (operators.length > 0) return true
        }
        return same(actual, expected)
    })
}

function applyUpdate(document, update) {
    if (update.$set) Object.assign(document, update.$set)
    if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete document[key]
    }
    if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
            document[key] = Number(document[key] || 0) + Number(amount)
        }
    }
    return document
}

function duplicateKeyError() {
    const error = new Error("duplicate key")
    error.code = 11000
    return error
}

function createPendingCheckoutModel() {
    const records = []
    return {
        records,
        async findOne(query) {
            return records.find((record) => matches(record, query)) || null
        },
        async create(payload) {
            if (
                payload.checkoutType === "reservation" &&
                payload.activeReservationAttempt === true &&
                records.some((record) =>
                    record.checkoutType === "reservation" &&
                    record.activeReservationAttempt === true &&
                    same(record.reservationId, payload.reservationId)
                )
            ) throw duplicateKeyError()
            if (
                payload.stripeSessionId &&
                records.some((record) => record.stripeSessionId === payload.stripeSessionId)
            ) throw duplicateKeyError()
            if (
                payload.idempotencyKey &&
                records.some((record) =>
                    record.businessId === payload.businessId &&
                    record.idempotencyKey === payload.idempotencyKey
                )
            ) throw duplicateKeyError()
            const record = { ...payload }
            records.push(record)
            return record
        },
        async findOneAndUpdate(query, update) {
            const record = records.find((entry) => matches(entry, query))
            return record ? applyUpdate(record, update) : null
        },
        async updateOne(query, update) {
            const record = records.find((entry) => matches(entry, query))
            if (!record) return { matchedCount: 0, modifiedCount: 0 }
            const before = JSON.stringify(record)
            applyUpdate(record, update)
            return {
                matchedCount: 1,
                modifiedCount: before === JSON.stringify(record) ? 0 : 1,
            }
        },
    }
}

function createReservationModel(reservation) {
    const records = [reservation]
    return {
        records,
        async findById(id) {
            return records.find((record) => same(record._id, id)) || null
        },
        async findOne(query) {
            return records.find((record) => matches(record, query)) || null
        },
        async findOneAndUpdate(query, update) {
            const record = records.find((entry) => matches(entry, query))
            return record ? applyUpdate(record, update) : null
        },
        async updateOne(query, update) {
            const record = records.find((entry) => matches(entry, query))
            if (!record) return { matchedCount: 0, modifiedCount: 0 }
            const before = JSON.stringify(record)
            applyUpdate(record, update)
            return {
                matchedCount: 1,
                modifiedCount: before === JSON.stringify(record) ? 0 : 1,
            }
        },
    }
}

function createStripeClient({ timeoutFirst = false } = {}) {
    const byKey = new Map()
    const byId = new Map()
    const calls = []
    let sequence = 0
    let timedOut = false
    return {
        calls,
        byKey,
        byId,
        checkout: {
            sessions: {
                async create(config, { idempotencyKey }) {
                    calls.push({ config, idempotencyKey })
                    const serialized = JSON.stringify(config)
                    const existing = byKey.get(idempotencyKey)
                    if (existing) {
                        if (existing.serialized !== serialized) {
                            const error = new Error("incompatible idempotent replay")
                            error.type = "StripeIdempotencyError"
                            throw error
                        }
                        return existing.session
                    }
                    sequence += 1
                    const session = {
                        id: `cs_test_${sequence}`,
                        url: `https://checkout.stripe.test/session/${sequence}`,
                        status: "open",
                        payment_status: "unpaid",
                        amount_total: config.line_items.reduce(
                            (sum, item) => sum + item.price_data.unit_amount * item.quantity,
                            0,
                        ),
                        currency: config.line_items[0].price_data.currency,
                        metadata: { ...config.metadata },
                        payment_intent: null,
                        expires_at: Math.floor(Date.now() / 1000) + 3600,
                    }
                    byKey.set(idempotencyKey, { serialized, session })
                    byId.set(session.id, session)
                    if (timeoutFirst && !timedOut) {
                        timedOut = true
                        const error = new Error("socket timeout")
                        error.type = "StripeConnectionError"
                        throw error
                    }
                    return session
                },
                async retrieve(id) {
                    return byId.get(id)
                },
            },
        },
    }
}

function createFixture(options = {}) {
    const reservation = {
        _id: options.reservationId || new mongoose.Types.ObjectId(),
        businessId: options.businessId || "business-a",
        status: options.status || "accepted_awaiting_payment",
        paymentStatus: options.paymentStatus || "pending",
        grossAmount: options.amountCents || 30000,
        currency: options.currency || "eur",
        pricingSnapshotVersion: 1,
        commissionAmountCents: 900,
        stripeConnectedAccountId: "acct_a",
        paymentReconciliationStatus: null,
        unexpectedPaymentCount: 0,
        unexpectedPaymentAmountCents: 0,
    }
    const business = {
        businessId: reservation.businessId,
        stripeAccountId: "acct_a",
    }
    const PendingCheckoutModel = createPendingCheckoutModel()
    const ReservationModel = createReservationModel(reservation)
    const stripeClient = createStripeClient(options)
    const stripeSessionConfigFactory = (attemptId) => ({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
            price_data: {
                currency: reservation.currency,
                product_data: { name: "Reservation" },
                unit_amount: reservation.grossAmount,
            },
            quantity: 1,
        }],
        metadata: {
            reservationId: String(reservation._id),
            businessId: reservation.businessId,
            pendingCheckoutId: attemptId,
            paymentAttemptId: attemptId,
            type: "reservation_payment",
        },
        payment_intent_data: {
            application_fee_amount: reservation.commissionAmountCents,
            transfer_data: { destination: business.stripeAccountId },
        },
        success_url: `https://app.test/reservation/confirmation/${reservation._id}`,
        cancel_url: "https://app.test/reservation/pay/token",
    })
    const start = () => createOrReuseReservationCheckout({
        reservation,
        business,
        amountCents: reservation.grossAmount,
        currency: reservation.currency,
        stripeSessionConfigFactory,
        stripeClient,
        PendingCheckoutModel,
        ReservationModel,
    })
    return {
        reservation,
        business,
        PendingCheckoutModel,
        ReservationModel,
        stripeClient,
        stripeSessionConfigFactory,
        start,
    }
}

function paidSession(fixture, sessionId = null) {
    const attempt = fixture.PendingCheckoutModel.records.find(
        (record) => record.checkoutType === "reservation" &&
            (!sessionId || record.stripeSessionId === sessionId),
    )
    const providerSession = fixture.stripeClient.byId.get(
        sessionId || attempt.stripeSessionId,
    )
    return {
        ...providerSession,
        status: "complete",
        payment_status: "paid",
        payment_intent: `pi_${providerSession.id}`,
    }
}

async function reconcile(fixture, session, eventId = `evt_${session.id}`) {
    return reconcileReservationCheckoutCompleted({
        stripeSession: session,
        eventId,
        PendingCheckoutModel: fixture.PendingCheckoutModel,
        ReservationModel: fixture.ReservationModel,
    })
}

test("1. first request creates one active reservation payment attempt", async () => {
    const fixture = createFixture()
    await fixture.start()
    assert.equal(fixture.PendingCheckoutModel.records.filter((r) => r.activeReservationAttempt).length, 1)
})

test("2. first request creates one Stripe Session identity", async () => {
    const fixture = createFixture()
    await fixture.start()
    assert.equal(fixture.stripeClient.byKey.size, 1)
})

test("3. sequential retry returns the same attempt", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const second = await fixture.start()
    assert.equal(second.attemptId, first.attemptId)
})

test("4. sequential retry returns the same Stripe Session", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const second = await fixture.start()
    assert.equal(second.stripeSessionId, first.stripeSessionId)
})

test("5. multiple sequential retries create no additional provider identity", async () => {
    const fixture = createFixture()
    await fixture.start(); await fixture.start(); await fixture.start()
    assert.equal(fixture.stripeClient.byKey.size, 1)
})

test("6. concurrent retries retain one database active attempt", async () => {
    const fixture = createFixture()
    await Promise.all([fixture.start(), fixture.start()])
    assert.equal(fixture.PendingCheckoutModel.records.filter((r) => r.activeReservationAttempt).length, 1)
})

test("7. concurrent retries resolve one provider Session identity", async () => {
    const fixture = createFixture()
    const results = await Promise.all([fixture.start(), fixture.start()])
    assert.equal(new Set(results.map((result) => result.stripeSessionId)).size, 1)
    assert.equal(fixture.stripeClient.byKey.size, 1)
})

test("8. client input cannot select the server-generated payment attempt ID", async () => {
    const fixture = createFixture()
    const result = await fixture.start()
    assert.ok(mongoose.isValidObjectId(result.attemptId))
    assert.notEqual(result.attemptId, "client-attempt")
})

test("9. tenant mismatch on an active attempt fails closed", async () => {
    const fixture = createFixture()
    await fixture.start()
    fixture.PendingCheckoutModel.records[0].businessId = "business-b"
    await assert.rejects(fixture.start(), (error) =>
        error instanceof ReservationPaymentAttemptError &&
        error.code === "RESERVATION_ATTEMPT_TENANT_MISMATCH")
})

test("10. checkout controller rejects a Reservation outside awaiting-payment state", async () => {
    const source = await readFile(new URL("../src/controllers/paymentController.js", import.meta.url), "utf8")
    assert.match(source, /reservation\.status !== "accepted_awaiting_payment"/)
})

test("11. one attempt uses the documented stable Stripe idempotency key", async () => {
    const fixture = createFixture()
    const result = await fixture.start()
    assert.equal(
        fixture.stripeClient.calls[0].idempotencyKey,
        buildReservationStripeIdempotencyKey(fixture.reservation._id, result.attemptId),
    )
})

test("12. same attempt and exact request reuses the provider result", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const attempt = fixture.PendingCheckoutModel.records[0]
    attempt.status = "provider_pending"
    attempt.stripeSessionId = null
    attempt.stripeCheckoutUrl = null
    const second = await fixture.start()
    assert.equal(second.stripeSessionId, first.stripeSessionId)
})

test("13. incompatible Stripe idempotency replay is surfaced as conflict", async () => {
    const fixture = createFixture()
    await fixture.start()
    const attempt = fixture.PendingCheckoutModel.records[0]
    attempt.status = "provider_pending"
    attempt.stripeSessionId = null
    attempt.stripeCheckoutUrl = null
    attempt.stripeRequestSnapshot = {
        ...attempt.stripeRequestSnapshot,
        success_url: "https://different.test/success",
    }
    await assert.rejects(fixture.start(), (error) =>
        error.code === "STRIPE_IDEMPOTENCY_CONFLICT" && error.statusCode === 409)
})

test("14. ambiguous provider timeout retries to the original Session", async () => {
    const fixture = createFixture({ timeoutFirst: true })
    await assert.rejects(fixture.start(), (error) => error.code === "STRIPE_CREATION_OUTCOME_UNKNOWN")
    const retry = await fixture.start()
    assert.equal(retry.stripeSessionId, "cs_test_1")
    assert.equal(fixture.stripeClient.byKey.size, 1)
})

test("15. expected paid Stripe Session webhook succeeds", async () => {
    const fixture = createFixture()
    await fixture.start()
    const result = await reconcile(fixture, paidSession(fixture))
    assert.equal(result.accepted, true)
    assert.equal(result.transitioned, true)
})

test("16. wrong Session ID is not accepted as canonical payment", async () => {
    const fixture = createFixture()
    await fixture.start()
    const wrong = { ...paidSession(fixture), id: "cs_wrong" }
    const result = await reconcile(fixture, wrong)
    assert.equal(result.accepted, false)
    assert.equal(fixture.reservation.paymentStatus, "pending")
})

test("17. wrong provider amount is denied and reconciled", async () => {
    const fixture = createFixture()
    await fixture.start()
    const result = await reconcile(fixture, { ...paidSession(fixture), amount_total: 29999 })
    assert.equal(result.code, "PAYMENT_AMOUNT_MISMATCH")
    assert.equal(fixture.reservation.paymentReconciliationStatus, "required")
})

test("18. wrong provider currency is denied and reconciled", async () => {
    const fixture = createFixture()
    await fixture.start()
    const result = await reconcile(fixture, { ...paidSession(fixture), currency: "usd" })
    assert.equal(result.code, "PAYMENT_CURRENCY_MISMATCH")
    assert.equal(fixture.reservation.paymentStatus, "pending")
})

test("19. production webhook wrapper verifies signature before durable claim", async () => {
    const source = await readFile(new URL("../src/controllers/webhookController.js", import.meta.url), "utf8")
    const wrapper = source.slice(source.indexOf("export async function handleDurableStripeWebhook"))
    assert.ok(wrapper.indexOf("constructEvent(") < wrapper.indexOf("claimEvent("))
    assert.match(wrapper, /Signature verification failed/)
})

test("20. duplicate successful Session delivery is idempotent", async () => {
    const fixture = createFixture()
    await fixture.start()
    const session = paidSession(fixture)
    const first = await reconcile(fixture, session, "evt_first")
    const second = await reconcile(fixture, session, "evt_second")
    assert.equal(first.transitioned, true)
    assert.equal(second.alreadyPaid, true)
})

test("21. Reservation payment state transitions to paid only once", async () => {
    const fixture = createFixture()
    await fixture.start()
    const session = paidSession(fixture)
    const results = await Promise.all([
        reconcile(fixture, session, "evt_a"),
        reconcile(fixture, session, "evt_b"),
    ])
    assert.equal(results.filter((result) => result.transitioned).length, 1)
    assert.equal(fixture.reservation.paymentStatus, "paid")
})

test("22. canonical transaction row retains one original paid amount", async () => {
    const fixture = createFixture()
    await fixture.start()
    await reconcile(fixture, paidSession(fixture))
    const transaction = toReservationTransaction(fixture.reservation)
    assert.equal(transaction.originalAmountPaidCents, 30000)
})

test("23. duplicate webhook produces no second email-dispatch transition", async () => {
    const fixture = createFixture()
    await fixture.start()
    const session = paidSession(fixture)
    const outcomes = [
        await reconcile(fixture, session, "evt_email_1"),
        await reconcile(fixture, session, "evt_email_2"),
    ]
    assert.equal(outcomes.filter((result) => result.transitioned).length, 1)
})

test("24. unexpected second successful Session is detected", async () => {
    const fixture = createFixture()
    await fixture.start()
    await reconcile(fixture, paidSession(fixture), "evt_canonical")
    const second = {
        ...paidSession(fixture),
        id: "cs_duplicate_paid",
        payment_intent: "pi_duplicate_paid",
    }
    const result = await reconcile(fixture, second, "evt_duplicate")
    assert.equal(result.code, "DUPLICATE_PAYMENT_RECORDED")
})

test("25. unexpected second payment does not pay the Reservation twice", async () => {
    const fixture = createFixture()
    await fixture.start()
    const canonical = paidSession(fixture)
    await reconcile(fixture, canonical, "evt_canonical")
    const paidAt = fixture.reservation.paidAt
    await reconcile(fixture, { ...canonical, id: "cs_second" }, "evt_second")
    assert.equal(fixture.reservation.paidAt, paidAt)
    assert.equal(fixture.reservation.stripeCheckoutSessionId, canonical.id)
})

test("26. transaction reporting includes unexpected provider-capture evidence", async () => {
    const fixture = createFixture()
    await fixture.start()
    const canonical = paidSession(fixture)
    await reconcile(fixture, canonical, "evt_canonical")
    await reconcile(fixture, { ...canonical, id: "cs_second" }, "evt_second")
    const transaction = toReservationTransaction(fixture.reservation)
    assert.equal(transaction.unexpectedPaymentAmountCents, 30000)
    assert.equal(transaction.providerCapturedAmountCents, 60000)
})

test("27. duplicate-payment reconciliation state is durable", async () => {
    const fixture = createFixture()
    await fixture.start()
    const canonical = paidSession(fixture)
    await reconcile(fixture, canonical, "evt_canonical")
    await reconcile(fixture, { ...canonical, id: "cs_second" }, "evt_second")
    const evidence = fixture.PendingCheckoutModel.records.find((record) => record.stripeSessionId === "cs_second")
    assert.equal(evidence.reconciliationStatus, "required")
    assert.equal(evidence.status, "reconciliation_required")
})

test("28. duplicate reconciliation does not invent an ad hoc Stripe refund", async () => {
    const source = await readFile(new URL("../src/services/reservationPaymentAttemptService.js", import.meta.url), "utf8")
    assert.doesNotMatch(source, /stripeClient\.refunds\.create/)
    const refundSource = await readFile(new URL("../src/services/reservationCancellationService.js", import.meta.url), "utf8")
    assert.match(refundSource, /ReservationRefund/)
})

test("29. unresolved duplicate payment remains visible and actionable", async () => {
    const fixture = createFixture()
    await fixture.start()
    const canonical = paidSession(fixture)
    await reconcile(fixture, canonical, "evt_canonical")
    await reconcile(fixture, { ...canonical, id: "cs_second" }, "evt_second")
    assert.equal(fixture.reservation.paymentReconciliationStatus, "required")
    assert.equal(fixture.reservation.unexpectedPaymentCount, 1)
})

test("30. cross-tenant duplicate-payment attempt is rejected", async () => {
    const fixture = createFixture()
    await fixture.start()
    const canonical = paidSession(fixture)
    await reconcile(fixture, canonical, "evt_canonical")
    fixture.PendingCheckoutModel.records.push({
        _id: new mongoose.Types.ObjectId(),
        checkoutType: "reservation",
        businessId: "business-b",
        reservationId: fixture.reservation._id,
        stripeSessionId: "cs_cross_tenant",
        reconciliationStatus: null,
    })
    const crossTenant = { ...canonical, id: "cs_cross_tenant" }
    await assert.rejects(
        reconcile(fixture, crossTenant, "evt_cross_tenant"),
        (error) => error.code === "UNEXPECTED_PAYMENT_TENANT_MISMATCH",
    )
})

test("31. valid active Checkout attempt is reused", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const second = await fixture.start()
    assert.equal(second.sessionUrl, first.sessionUrl)
    assert.equal(second.replayed, true)
})

test("32. provider-confirmed expired Session is marked terminal", async () => {
    const fixture = createFixture()
    await fixture.start()
    const firstAttempt = fixture.PendingCheckoutModel.records[0]
    firstAttempt.stripeExpiresAt = new Date(Date.now() - 1000)
    fixture.stripeClient.byId.get(firstAttempt.stripeSessionId).status = "expired"
    await fixture.start()
    assert.equal(firstAttempt.status, "expired")
    assert.equal(firstAttempt.activeReservationAttempt, null)
})

test("33. a new genuine attempt is allowed after provider-confirmed expiry", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const firstAttempt = fixture.PendingCheckoutModel.records[0]
    firstAttempt.stripeExpiresAt = new Date(Date.now() - 1000)
    fixture.stripeClient.byId.get(first.stripeSessionId).status = "expired"
    const second = await fixture.start()
    assert.notEqual(second.attemptId, first.attemptId)
    assert.notEqual(second.stripeSessionId, first.stripeSessionId)
})

test("34. paid webhook for a superseded attempt is reconciled, not accepted", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const oldAttempt = fixture.PendingCheckoutModel.records[0]
    oldAttempt.stripeExpiresAt = new Date(Date.now() - 1000)
    fixture.stripeClient.byId.get(first.stripeSessionId).status = "expired"
    await fixture.start()
    const latePaid = {
        ...fixture.stripeClient.byId.get(first.stripeSessionId),
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_late",
    }
    const result = await reconcile(fixture, latePaid, "evt_late")
    assert.equal(result.accepted, false)
    assert.equal(fixture.reservation.paymentStatus, "pending")
    assert.equal(oldAttempt.reconciliationStatus, "required")
})

test("35. concurrent expiry retries converge on one replacement attempt", async () => {
    const fixture = createFixture()
    const first = await fixture.start()
    const oldAttempt = fixture.PendingCheckoutModel.records[0]
    oldAttempt.stripeExpiresAt = new Date(Date.now() - 1000)
    fixture.stripeClient.byId.get(first.stripeSessionId).status = "expired"
    const replacements = await Promise.all([fixture.start(), fixture.start()])
    assert.equal(new Set(replacements.map((result) => result.attemptId)).size, 1)
    assert.equal(fixture.PendingCheckoutModel.records.filter((record) => record.activeReservationAttempt).length, 1)
})

test("attempt fingerprint binds reservation, tenant, amount, currency, account, and snapshot version", () => {
    const base = {
        reservationId: "reservation-a",
        businessId: "business-a",
        amountCents: 30000,
        currency: "eur",
        connectedAccountId: "acct_a",
        pricingSnapshotVersion: 1,
    }
    assert.notEqual(
        buildReservationPaymentAttemptFingerprint(base),
        buildReservationPaymentAttemptFingerprint({ ...base, businessId: "business-b" }),
    )
})

test("provider validation is bound to persisted attempt metadata", () => {
    const attempt = {
        _id: "attempt-a",
        reservationId: "reservation-a",
        businessId: "business-a",
        grossAmount: 30000,
        currency: "eur",
        legacyProviderSession: false,
    }
    const result = validateReservationProviderSession({
        amount_total: 30000,
        currency: "eur",
        metadata: {
            pendingCheckoutId: "attempt-b",
            reservationId: "reservation-a",
            businessId: "business-a",
        },
    }, attempt)
    assert.equal(result.code, "PAYMENT_ATTEMPT_MISMATCH")
})

test("signed reservation expiry event clears the active slot", async () => {
    const fixture = createFixture()
    await fixture.start()
    const attempt = fixture.PendingCheckoutModel.records[0]
    const expired = {
        ...fixture.stripeClient.byId.get(attempt.stripeSessionId),
        status: "expired",
    }
    const result = await reconcileReservationCheckoutExpired({
        stripeSession: expired,
        PendingCheckoutModel: fixture.PendingCheckoutModel,
        ReservationModel: fixture.ReservationModel,
    })
    assert.equal(result.handled, true)
    assert.equal(attempt.activeReservationAttempt, null)
})
