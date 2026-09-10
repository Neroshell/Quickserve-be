import assert from "node:assert/strict"
import test from "node:test"

process.env.REDIS_URL = ""
process.env.BULLMQ_NOTIFICATIONS_ENABLED = "false"

const [
    {
        NOTIFICATION_CATEGORIES,
        NOTIFICATION_ENTITY_TYPES,
        NOTIFICATION_RETENTION_DAYS,
        NOTIFICATION_SEVERITIES,
        NOTIFICATION_TYPES,
    },
    { MANAGEMENT_ACCESS_AREAS },
    { BILLING_JOB_NAMES },
    { prepareNotificationEvent },
    {
        notifyBillingInvoicePaymentFailed,
        notifyBillingServiceRestricted,
        notifyReservationRefundFailed,
    },
    {
        FINANCIAL_NOTIFICATION_METHODS,
        safelyNotifyFinancialEvent,
    },
    { resolveNotificationRecipients },
    { getBillingActionPeriodKey, processBillingLifecycleAction },
    { reconcileReservationRefund },
    { handleStripeWebhook },
] = await Promise.all([
    import("../src/constants/notifications.js"),
    import("../src/constants/managementAccess.js"),
    import("../src/queues/queueNames.js"),
    import("../src/services/notificationEventRegistry.js"),
    import("../src/services/financialNotificationService.js"),
    import("../src/services/financialNotificationIntegrationService.js"),
    import("../src/services/notificationRecipientService.js"),
    import("../src/services/billingLifecycleService.js"),
    import("../src/services/reservationCancellationService.js"),
    import("../src/controllers/webhookController.js"),
])

function queryResult(value) {
    return {
        select() { return this },
        session() { return this },
        async lean() { return value },
    }
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        send(value) {
            this.body = value
            return this
        },
        json(value) {
            this.body = value
            return this
        },
    }
}

function invoiceFailureEvent(overrides = {}) {
    return {
        id: "evt_invoice_failed_1",
        type: "invoice.payment_failed",
        created: 1788948000,
        data: {
            object: {
                id: "in_failed_1",
                number: "QS-2026-0042",
                subscription: "sub_1",
                customer: "cus_1",
                status: "open",
                paid: false,
                currency: "eur",
                amount_due: 2500,
                amount_paid: 0,
            },
        },
        ...overrides,
    }
}

function setPath(object, path, value) {
    const parts = path.split(".")
    const final = parts.pop()
    let target = object
    for (const part of parts) {
        if (!target[part] || typeof target[part] !== "object") target[part] = {}
        target = target[part]
    }
    target[final] = value
}

function lifecycleStore(overrides = {}) {
    const document = {
        _id: "business-object-1",
        businessId: "business-1",
        ownerEmail: "owner@example.com",
        status: "active",
        stripeSubscriptionId: "sub_1",
        billingStatus: "past_due",
        billingFailedAt: new Date("2026-09-01T00:00:00.000Z"),
        offlineServiceRestricted: false,
        offlineServiceRestrictedAt: null,
        billingLifecycleClaims: {
            upcomingInvoice: {},
            overdueWarningDay3: {},
            overdueWarningDay5: {},
            restrictService: {},
            restoreService: {},
        },
        ...overrides,
    }
    function apply(update) {
        for (const [path, value] of Object.entries(update?.$set || {})) {
            setPath(document, path, value)
        }
    }
    return {
        document,
        async findOne() { return structuredClone(document) },
        async findOneAndUpdate(_filter, update) {
            apply(update)
            return structuredClone(document)
        },
        async updateOne(_filter, update) {
            apply(update)
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }
}

test("Phase 5 registry definitions are critical, bounded, and retain 30-day history", () => {
    const refund = prepareNotificationEvent({
        type: NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED,
        facts: { reservationReference: "reservation 123" },
    })
    const invoice = prepareNotificationEvent({
        type: NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED,
        facts: { invoiceReference: "QS-2026-0042" },
    })
    const restricted = prepareNotificationEvent({
        type: NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED,
        facts: { unsafe: "must not persist" },
    })

    assert.equal(refund.severity, NOTIFICATION_SEVERITIES.CRITICAL)
    assert.equal(refund.entityType, NOTIFICATION_ENTITY_TYPES.RESERVATION)
    assert.deepEqual(refund.metadata, { reservationReference: "reservation 123" })
    assert.equal(invoice.category, NOTIFICATION_CATEGORIES.BILLING)
    assert.equal(invoice.entityType, NOTIFICATION_ENTITY_TYPES.BILLING_INVOICE)
    assert.deepEqual(invoice.metadata, { invoiceReference: "QS-2026-0042" })
    assert.equal(restricted.entityType, NOTIFICATION_ENTITY_TYPES.BUSINESS)
    assert.deepEqual(restricted.metadata, {})
    assert.equal(NOTIFICATION_RETENTION_DAYS, 30)
    assert.equal(NOTIFICATION_TYPES.BILLING_INVOICE_PAID, undefined)
    assert.equal(NOTIFICATION_TYPES.RESERVATION_REFUND_SUCCEEDED, undefined)
})

test("failed invoice adapter uses the durable ledger identity and Stripe event identity", async () => {
    const captured = []
    const billingInvoice = {
        _id: "invoice-object-1",
        businessId: "business-1",
        stripeInvoiceId: "in_failed_1",
        status: "failed",
    }
    const createEvent = async (event) => {
        captured.push(event)
        return { created: captured.length === 1 }
    }

    await notifyBillingInvoicePaymentFailed({
        billingInvoice,
        stripeInvoice: { number: "QS-2026-0042" },
        providerEventId: "evt_invoice_failed_1",
        occurredAt: new Date("2026-09-09T09:00:00.000Z"),
    }, { createEvent })
    await notifyBillingInvoicePaymentFailed({
        billingInvoice,
        stripeInvoice: { number: "QS-2026-0042" },
        providerEventId: "evt_invoice_failed_1",
    }, { createEvent })
    const paid = await notifyBillingInvoicePaymentFailed({
        billingInvoice: { ...billingInvoice, status: "paid" },
        providerEventId: "evt_late_failure",
    }, { createEvent })

    assert.equal(captured.length, 2)
    assert.equal(captured[0].businessId, "business-1")
    assert.equal(captured[0].entityId, "invoice-object-1")
    assert.equal(captured[0].type, NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED)
    assert.equal(
        captured[0].idempotencyKey,
        "billing.invoice_payment_failed:invoice-object-1:evt_invoice_failed_1",
    )
    assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey)
    assert.deepEqual(captured[0].facts, { invoiceReference: "QS-2026-0042" })
    assert.equal(paid.skipped, true)
})

test("distinct Stripe failure events remain distinct notification occurrences", async () => {
    const keys = []
    const billingInvoice = {
        _id: "invoice-object-1",
        businessId: "business-1",
        stripeInvoiceId: "in_failed_1",
        status: "failed",
    }
    for (const providerEventId of ["evt_attempt_1", "evt_attempt_2"]) {
        await notifyBillingInvoicePaymentFailed({ billingInvoice, providerEventId }, {
            createEvent: async (event) => {
                keys.push(event.idempotencyKey)
                return { created: true }
            },
        })
    }
    assert.equal(new Set(keys).size, 2)
})

test("invoice.payment_failed notifies only after business and invoice failure persistence", async () => {
    const sequence = []
    const event = invoiceFailureEvent()
    const business = {
        _id: "business-object-1",
        businessId: "business-1",
        stripeSubscriptionId: "sub_1",
        billingFailedAt: null,
    }
    const BusinessModel = {
        async findOne(filter) {
            assert.deepEqual(filter, { stripeSubscriptionId: "sub_1" })
            return business
        },
        async findOneAndUpdate(filter, update) {
            assert.equal(filter.businessId, "business-1")
            Object.assign(business, update.$set)
            sequence.push("business-persisted")
            return { ...business }
        },
    }
    const response = responseRecorder()
    await handleStripeWebhook({
        headers: {},
        stripeWebhookEvent: event,
        app: {
            locals: {
                BusinessModel,
                upsertBillingInvoiceFromStripe: async ({ businessId, invoice }) => {
                    assert.equal(businessId, "business-1")
                    sequence.push("invoice-persisted")
                    return {
                        _id: "invoice-object-1",
                        businessId,
                        stripeInvoiceId: invoice.id,
                        status: "failed",
                    }
                },
                invalidateBusinessConfiguration: async () => {
                    sequence.push("cache-invalidated")
                },
                notifyBillingInvoicePaymentFailed: async (input) => {
                    assert.equal(business.billingStatus, "past_due")
                    assert.equal(input.billingInvoice.status, "failed")
                    sequence.push("notification")
                    return { created: true }
                },
            },
        },
    }, response)

    assert.equal(response.statusCode, 200)
    assert.deepEqual(sequence, [
        "business-persisted",
        "invoice-persisted",
        "cache-invalidated",
        "notification",
    ])
})

test("notification failure does not change successful invoice failure processing", async (t) => {
    t.mock.method(console, "error", () => {})
    const event = invoiceFailureEvent()
    const business = {
        _id: "business-object-1",
        businessId: "business-1",
        stripeSubscriptionId: "sub_1",
        billingFailedAt: null,
    }
    const response = responseRecorder()
    await handleStripeWebhook({
        headers: {},
        stripeWebhookEvent: event,
        app: {
            locals: {
                BusinessModel: {
                    async findOne() { return business },
                    async findOneAndUpdate(_filter, update) {
                        Object.assign(business, update.$set)
                        return { ...business }
                    },
                },
                upsertBillingInvoiceFromStripe: async () => ({
                    _id: "invoice-object-1",
                    businessId: "business-1",
                    stripeInvoiceId: "in_failed_1",
                    status: "failed",
                }),
                invalidateBusinessConfiguration: async () => {},
                notifyBillingInvoicePaymentFailed: async () => {
                    throw new Error("notification unavailable")
                },
            },
        },
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(business.billingStatus, "past_due")
})

test("restriction adapter is stable per overdue period and recovery remains silent", async () => {
    const captured = []
    const business = {
        businessId: "business-1",
        offlineServiceRestricted: true,
        offlineServiceRestrictedAt: new Date("2026-09-08T00:00:00.000Z"),
    }
    const createEvent = async (event) => {
        captured.push(event)
        return { created: true }
    }
    await notifyBillingServiceRestricted({
        business,
        periodKey: "failure-2026-09-01T00:00:00.000Z",
    }, { createEvent })
    await notifyBillingServiceRestricted({
        business,
        periodKey: "failure-2026-09-01T00:00:00.000Z",
    }, { createEvent })
    const recovered = await notifyBillingServiceRestricted({
        business: { ...business, offlineServiceRestricted: false },
        periodKey: "failure-2026-09-01T00:00:00.000Z",
    }, { createEvent })

    assert.equal(captured.length, 2)
    assert.equal(captured[0].entityId, "business-1")
    assert.equal(captured[0].type, NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED)
    assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey)
    assert.equal(recovered.skipped, true)
})

test("service restriction is durable before notification and bell failure is isolated", async (t) => {
    t.mock.method(console, "error", () => {})
    const now = new Date("2026-09-09T00:00:00.000Z")
    const store = lifecycleStore()
    const periodKey = getBillingActionPeriodKey(
        BILLING_JOB_NAMES.RESTRICT_SERVICE,
        store.document,
    )
    let observedRestricted = false
    const result = await processBillingLifecycleAction({
        jobName: BILLING_JOB_NAMES.RESTRICT_SERVICE,
        businessId: store.document.businessId,
        periodKey,
        now,
        businessModel: store,
        sendNotification: async () => ({ success: true }),
        sendOwnerNotification: async () => {
            observedRestricted = store.document.offlineServiceRestricted === true
            throw new Error("notification unavailable")
        },
    })

    assert.equal(result.success, true)
    assert.equal(result.ownerNotification.failed, true)
    assert.equal(observedRestricted, true)
    assert.equal(store.document.offlineServiceRestricted, true)
    assert.equal(
        store.document.billingLifecycleClaims.restrictService.status,
        "completed",
    )
})

test("refund failure adapter deep-links to Reservation and keys by Refund identity", async () => {
    const captured = []
    const refund = {
        refundId: "RF-FAILURE-1",
        businessId: "hotel-1",
        reservationId: "reservation-object-1",
        status: "failed",
        failedAt: new Date("2026-09-09T10:00:00.000Z"),
    }
    const createEvent = async (event) => {
        captured.push(event)
        return { created: true }
    }
    await notifyReservationRefundFailed({ refund }, { createEvent })
    await notifyReservationRefundFailed({ refund }, { createEvent })
    const pending = await notifyReservationRefundFailed({
        refund: { ...refund, status: "pending" },
    }, { createEvent })

    assert.equal(captured.length, 2)
    assert.equal(captured[0].businessId, "hotel-1")
    assert.equal(captured[0].entityId, "reservation-object-1")
    assert.equal(captured[0].type, NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED)
    assert.equal(
        captured[0].idempotencyKey,
        "reservation.refund_failed:reservation-object-1:RF-FAILURE-1",
    )
    assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey)
    assert.equal(pending.skipped, true)
})

test("provider refund failure persists and unlocks before notifying exactly once", async () => {
    const refund = {
        _id: "refund-object-1",
        refundId: "RF-FAILURE-1",
        businessId: "hotel-1",
        reservationId: "reservation-object-1",
        providerPaymentId: "pi_1",
        status: "pending",
    }
    const reservation = { activeRefundId: refund.refundId }
    const notifications = []
    const refundModel = {
        async findOneAndUpdate(filter, update) {
            assert.equal(filter.businessId, "hotel-1")
            Object.assign(refund, update.$set)
            return { ...refund }
        },
    }
    const reservationModel = {
        async updateOne(_filter, update) {
            Object.assign(reservation, update.$set)
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }
    const input = {
        refundRecord: refund,
        providerRefund: {
            id: "re_failed_1",
            payment_intent: "pi_1",
            status: "failed",
            failure_reason: "expired_or_canceled_card",
        },
        refundModel,
        reservationModel,
        sendOwnerRefundFailure: async ({ refund: failedRefund }) => {
            assert.equal(failedRefund.status, "failed")
            assert.equal(reservation.activeRefundId, null)
            notifications.push(failedRefund.refundId)
            return { created: true }
        },
        now: new Date("2026-09-09T10:00:00.000Z"),
    }

    const first = await reconcileReservationRefund(input)
    const duplicate = await reconcileReservationRefund(input)

    assert.equal(first.refund.status, "failed")
    assert.equal(duplicate.refund.status, "failed")
    assert.deepEqual(notifications, ["RF-FAILURE-1"])
})

test("refund notification failure cannot roll back the failed refund state", async (t) => {
    t.mock.method(console, "error", () => {})
    const refund = {
        _id: "refund-object-2",
        refundId: "RF-FAILURE-2",
        businessId: "hotel-1",
        reservationId: "reservation-object-2",
        providerPaymentId: "pi_2",
        status: "pending",
    }
    const result = await reconcileReservationRefund({
        refundRecord: refund,
        providerRefund: { id: "re_failed_2", status: "failed" },
        refundModel: {
            async findOneAndUpdate(_filter, update) {
                Object.assign(refund, update.$set)
                return { ...refund }
            },
        },
        reservationModel: {
            async updateOne() { return { matchedCount: 1, modifiedCount: 1 } },
        },
        sendOwnerRefundFailure: async () => {
            throw new Error("notification unavailable")
        },
    })

    assert.equal(result.refund.status, "failed")
    assert.ok(result.refund.failedAt instanceof Date)
})

test("financial events use canonical owner and authorized co-owner recipients only", async () => {
    const OWNER = "507f1f77bcf86cd799439201"
    const CO_OWNER = "507f1f77bcf86cd799439202"
    const RESTRICTED_CO_OWNER = "507f1f77bcf86cd799439203"
    const MANAGER = "507f1f77bcf86cd799439204"
    const WAITER = "507f1f77bcf86cd799439205"
    const BusinessModel = {
        findOne: () => queryResult({
            _id: OWNER,
            businessId: "business-1",
            ownerStatus: "active",
        }),
    }
    const StaffModel = {
        find: () => queryResult([
            {
                _id: CO_OWNER,
                role: "co_owner",
                accountStatus: "active",
                coOwnerRestrictions: [],
            },
            {
                _id: RESTRICTED_CO_OWNER,
                role: "co_owner",
                accountStatus: "active",
                coOwnerRestrictions: [MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING],
            },
            {
                _id: MANAGER,
                role: "manager",
                accountStatus: "active",
                permissions: ["transactions.view", "reservations.manage"],
            },
            {
                _id: WAITER,
                role: "waiter",
                accountStatus: "active",
                permissions: [],
            },
        ]),
    }

    for (const [type, facts] of [
        [NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED, { invoiceReference: "INV-1" }],
        [NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED, {}],
        [NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED, { reservationReference: "Reservation 1" }],
    ]) {
        const prepared = prepareNotificationEvent({ type, facts })
        const recipients = await resolveNotificationRecipients({
            businessId: "business-1",
            requiredAccessArea: prepared.requiredAccessArea,
            managerPermissions: prepared.managerPermissions,
            managersEligible: prepared.managersEligible,
        }, { BusinessModel, StaffModel })
        assert.deepEqual(
            recipients.map((recipient) => String(recipient.recipientId)),
            [OWNER, CO_OWNER],
        )
    }
})

test("financial notification integration catches adapter failures without changing domain results", async () => {
    const logs = []
    const result = await safelyNotifyFinancialEvent({
        method: FINANCIAL_NOTIFICATION_METHODS.INVOICE_PAYMENT_FAILED,
        input: {},
    }, {
        notify: async () => { throw new Error("notification unavailable") },
        logger: { error: (...args) => logs.push(args) },
        context: { businessId: "business-1" },
    })
    assert.equal(result.failed, true)
    assert.equal(logs.length, 1)
})
