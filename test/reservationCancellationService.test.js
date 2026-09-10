import assert from "node:assert/strict"
import test from "node:test"
import {
    cancelHotelReservation,
    classifyStripeRefundCreationError,
    getRemainingRefundableAmountCents,
    getReservationCapturedAmountCents,
    getReservationRefundEconomics,
    reconcileStripeReservationRefund,
    ReservationCancellationError,
} from "../src/services/reservationCancellationService.js"
import {
    canRefundReservation,
    getReservationRefundRoles,
} from "../src/services/reservationRefundAuthorization.js"

function comparable(value) {
    return value?._id !== undefined ? String(value._id) : String(value)
}

function matches(document, filter) {
    if (!document) return false
    for (const [key, condition] of Object.entries(filter || {})) {
        if (key === "$or") {
            if (!condition.some((branch) => matches(document, branch))) {
                return false
            }
            continue
        }
        const actual = document[key]
        if (
            condition &&
            typeof condition === "object" &&
            !(condition instanceof Date)
        ) {
            if ("$ne" in condition && actual === condition.$ne) return false
            if (
                "$in" in condition &&
                !condition.$in.some(
                    (value) => comparable(value) === comparable(actual),
                )
            ) {
                return false
            }
            if (
                "$lt" in condition &&
                !(actual && new Date(actual) < new Date(condition.$lt))
            ) {
                return false
            }
            continue
        }
        if (condition === null) {
            if (actual !== null && actual !== undefined) return false
        } else if (comparable(actual) !== comparable(condition)) {
            return false
        }
    }
    return true
}

function applyUpdate(document, operation) {
    if (operation?.$set) Object.assign(document, operation.$set)
    return document
}

function createStores(initialReservation) {
    const reservation = {
        ...initialReservation,
        toObject() {
            return { ...this, toObject: undefined }
        },
    }
    const refunds = []
    let sequence = 0

    const reservationModel = {
        async findOne(filter) {
            return matches(reservation, filter) ? reservation : null
        },
        async findOneAndUpdate(filter, operation) {
            if (!matches(reservation, filter)) return null
            return applyUpdate(reservation, operation)
        },
        async updateOne(filter, operation) {
            if (!matches(reservation, filter)) {
                return { matchedCount: 0, modifiedCount: 0 }
            }
            applyUpdate(reservation, operation)
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }

    const refundModel = {
        async create(values) {
            if (
                refunds.some(
                    (refund) =>
                        refund.idempotencyKey === values.idempotencyKey,
                )
            ) {
                const error = new Error("duplicate")
                error.code = 11000
                throw error
            }
            const refund = {
                _id: `refund-document-${++sequence}`,
                status: "pending",
                successfulAmountCents: 0,
                customerEmailSentAt: null,
                customerEmailSendingAt: null,
                ...values,
            }
            refunds.push(refund)
            return refund
        },
        async findOne(filter) {
            return refunds.find((refund) => matches(refund, filter)) || null
        },
        find(filter) {
            return {
                lean: async () =>
                    refunds.filter((refund) => matches(refund, filter)),
            }
        },
        async findOneAndUpdate(filter, operation) {
            const refund = refunds.find((row) => matches(row, filter))
            return refund ? applyUpdate(refund, operation) : null
        },
        async updateOne(filter, operation) {
            const refund = refunds.find((row) => matches(row, filter))
            if (!refund) return { matchedCount: 0, modifiedCount: 0 }
            applyUpdate(refund, operation)
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }

    return { reservation, refunds, reservationModel, refundModel }
}

function hotelReservation(overrides = {}) {
    return {
        _id: "reservation-1",
        businessId: "hotel-1",
        status: "confirmed",
        paymentStatus: "paid",
        checkInDate: "2026-08-10",
        checkOutDate: "2026-08-12",
        amountPaidCents: 30000,
        refundedAmountCents: 0,
        currency: "eur",
        stripePaymentIntentId: "pi_destination_charge_1",
        stripeConnectedAccountId: "acct_hotel_1",
        activeRefundId: null,
        email: null,
        ...overrides,
    }
}

function actor(role = "owner") {
    return {
        userId: `${role}-1`,
        businessId: "hotel-1",
        role,
        name: "Finance User",
        email: `${role}@example.com`,
    }
}

function request(overrides = {}) {
    return {
        businessId: "hotel-1",
        reservationId: "reservation-1",
        user: actor(),
        outcome: "full_refund",
        reason: "guest_request",
        notes: "Guest changed plans.",
        clientIdempotencyKey: "client-operation-key-0001",
        now: new Date("2026-07-30T12:00:00.000Z"),
        sendOwnerRefundFailure: async () => ({ created: true }),
        ...overrides,
    }
}

function stripeSuccess(calls, status = "succeeded") {
    return {
        refunds: {
            async create(payload, options) {
                calls.push({ payload, options })
                return {
                    id: "re_1",
                    payment_intent: payload.payment_intent,
                    amount: payload.amount,
                    status,
                    created: 1785412800,
                    metadata: payload.metadata,
                }
            },
        },
    }
}

test("refund permission is default-deny and currently limited to owner and co-owner", () => {
    assert.deepEqual(getReservationRefundRoles(), ["owner", "co_owner"])
    assert.equal(canRefundReservation(actor("owner")), true)
    assert.equal(canRefundReservation(actor("co_owner")), true)
    assert.equal(canRefundReservation(actor("receptionist")), false)
    assert.equal(canRefundReservation(actor("manager")), false)
    assert.equal(canRefundReservation(actor("admin")), false)
})

test("captured and remaining amounts use integer cents and cumulative successful refunds", () => {
    assert.equal(
        getReservationCapturedAmountCents({
            amountPaidCents: 25001,
            grossAmount: 25000,
            totalPrice: 250,
        }),
        25001,
    )
    assert.equal(
        getRemainingRefundableAmountCents({
            capturedAmountCents: 25001,
            successfulRefundedAmountCents: 12000,
        }),
        13001,
    )
})

test("refund economics deduct only customer-borne immutable online fees", () => {
    const customerPaysAll = getReservationRefundEconomics({
        reservation: hotelReservation({
            amountPaidCents: 30000,
            platformFeeCents: 1500,
            customerPlatformFeeCents: 1500,
            businessAbsorbedPlatformFeeCents: 0,
            customerProcessingFeeCents: 300,
        }),
    })
    assert.deepEqual(customerPaysAll, {
        paymentChannel: "online",
        customerPaidAmountCents: 30000,
        totalPlatformFeeCents: 1500,
        customerPlatformFeeCents: 1500,
        businessAbsorbedPlatformFeeCents: 0,
        customerProcessingFeeCents: 300,
        customerRefundableCeilingCents: 28200,
        successfulRefundedAmountCents: 0,
        remainingRefundableAmountCents: 28200,
    })

    const hotelPaysAll = getReservationRefundEconomics({
        reservation: hotelReservation({
            amountPaidCents: 28500,
            platformFeeCents: 1500,
            customerPlatformFeeCents: 0,
            businessAbsorbedPlatformFeeCents: 1500,
            businessProcessingFeeCents: 300,
        }),
    })
    assert.equal(hotelPaysAll.customerRefundableCeilingCents, 28500)
    assert.equal(hotelPaysAll.businessAbsorbedPlatformFeeCents, 1500)

    const split = getReservationRefundEconomics({
        reservation: hotelReservation({
            amountPaidCents: 29100,
            platformFeeCents: 1500,
            customerPlatformFeeCents: 600,
            businessAbsorbedPlatformFeeCents: 900,
        }),
        successfulRefundedAmountCents: 10000,
    })
    assert.equal(split.customerRefundableCeilingCents, 28500)
    assert.equal(split.remainingRefundableAmountCents, 18500)
    assert.equal(split.businessAbsorbedPlatformFeeCents, 900)
})

test("offline refund economics never manufacture online fee deductions", () => {
    const economics = getReservationRefundEconomics({
        reservation: hotelReservation({
            paymentChannel: "offline",
            paidVia: "cash",
            stripePaymentIntentId: null,
            amountPaidCents: 30000,
            platformFeeCents: 1500,
            customerPlatformFeeCents: 1500,
            customerProcessingFeeCents: 300,
        }),
    })

    assert.equal(economics.paymentChannel, "offline")
    assert.equal(economics.customerPlatformFeeCents, 0)
    assert.equal(economics.customerProcessingFeeCents, 0)
    assert.equal(economics.customerRefundableCeilingCents, 30000)
})

test("unpaid cancellation creates no refund record", async () => {
    const stores = createStores(
        hotelReservation({
            status: "accepted_awaiting_payment",
            paymentStatus: "pending",
            amountPaidCents: 0,
            stripePaymentIntentId: null,
        }),
    )

    const result = await cancelHotelReservation({
        ...request({
            outcome: "cancel_unpaid",
            user: actor("receptionist"),
        }),
        ...stores,
    })

    assert.equal(result.reservation.status, "cancelled")
    assert.equal(result.reservation.cancellationOutcome, "unpaid")
    assert.equal(stores.refunds.length, 0)
})

test("owner and co-owner may cancel paid reservations without refund while payment remains paid", async () => {
    for (const role of ["owner", "co_owner"]) {
        const stores = createStores(hotelReservation())
        const result = await cancelHotelReservation({
            ...request({
                outcome: "no_refund",
                user: actor(role),
                clientIdempotencyKey: `no-refund-${role}-0001`,
            }),
            ...stores,
        })

        assert.equal(result.reservation.status, "cancelled")
        assert.equal(result.reservation.paymentStatus, "paid")
        assert.equal(
            result.reservation.cancellationOutcome,
            "no_refund",
        )
        assert.equal(result.reservation.refundedAmountCents, 0)
        assert.equal(stores.refunds.length, 0)
        assert.equal(result.reservation.cancelledBy.role, role)
    }
})

test("staff cannot bypass refund authority through the paid cancellation service", async () => {
    const stores = createStores(hotelReservation())

    await assert.rejects(
        cancelHotelReservation({
            ...request({
                outcome: "no_refund",
                user: actor("receptionist"),
            }),
            ...stores,
        }),
        (error) =>
            error instanceof ReservationCancellationError &&
            error.status === 403 &&
            error.code === "REFUND_FORBIDDEN",
    )
    assert.equal(stores.reservation.status, "confirmed")
    assert.equal(stores.refunds.length, 0)
})

test("full refund uses the original PaymentIntent, retains Chillow fees, and preserves provider idempotency", async () => {
    const stores = createStores(hotelReservation())
    const calls = []
    const result = await cancelHotelReservation({
        ...request(),
        stripeClient: stripeSuccess(calls),
        ...stores,
    })

    assert.equal(calls.length, 1)
    assert.equal(
        calls[0].payload.payment_intent,
        "pi_destination_charge_1",
    )
    assert.equal(calls[0].payload.amount, 30000)
    assert.equal(calls[0].payload.reverse_transfer, true)
    assert.equal(calls[0].payload.refund_application_fee, false)
    assert.match(calls[0].options.idempotencyKey, /^reservation-cancellation\//)
    assert.equal(result.refund.providerRefundId, "re_1")
    assert.equal(result.refund.connectedAccountId, "acct_hotel_1")
    assert.equal(result.refund.status, "succeeded")
    assert.equal(result.reservation.status, "cancelled")
    assert.equal(result.reservation.paymentStatus, "refunded")
    assert.equal(result.reservation.refundedAmountCents, 30000)
})

test("full refund ceiling follows customer, hotel, and split Chillow fee ownership", async () => {
    for (const scenario of [
        {
            name: "customer-pays-all",
            amountPaidCents: 30000,
            totalFeeCents: 1500,
            customerFeeCents: 1500,
            businessFeeCents: 0,
            expectedRefundCents: 28500,
        },
        {
            name: "hotel-pays-all",
            amountPaidCents: 28500,
            totalFeeCents: 1500,
            customerFeeCents: 0,
            businessFeeCents: 1500,
            expectedRefundCents: 28500,
        },
        {
            name: "split",
            amountPaidCents: 29100,
            totalFeeCents: 1500,
            customerFeeCents: 600,
            businessFeeCents: 900,
            expectedRefundCents: 28500,
        },
    ]) {
        const stores = createStores(hotelReservation({
            amountPaidCents: scenario.amountPaidCents,
            platformFeeCents: scenario.totalFeeCents,
            commissionAmountCents: scenario.totalFeeCents,
            customerPlatformFeeCents: scenario.customerFeeCents,
            businessAbsorbedPlatformFeeCents: scenario.businessFeeCents,
        }))
        const calls = []
        const result = await cancelHotelReservation({
            ...request({
                clientIdempotencyKey:
                    `fee-ownership-${scenario.name}-0001`,
            }),
            stripeClient: stripeSuccess(calls),
            ...stores,
        })

        assert.equal(calls[0].payload.amount, scenario.expectedRefundCents)
        assert.equal(calls[0].payload.refund_application_fee, false)
        assert.equal(
            result.refund.customerPlatformFeeCents,
            scenario.customerFeeCents,
        )
        assert.equal(
            result.refund.businessAbsorbedPlatformFeeCents,
            scenario.businessFeeCents,
        )
        assert.equal(result.refund.totalPlatformFeeCents, scenario.totalFeeCents)
        assert.equal(result.reservation.paymentStatus, "refunded")
    }
})

test("customer processing fee is excluded while platform processing cost cannot reduce the refund", async () => {
    const stores = createStores(hotelReservation({
        amountPaidCents: 30000,
        customerPlatformFeeCents: 500,
        platformFeeCents: 1200,
        businessAbsorbedPlatformFeeCents: 700,
        customerProcessingFeeCents: 300,
        businessProcessingFeeCents: 900,
    }))
    const calls = []
    const result = await cancelHotelReservation({
        ...request({
            clientIdempotencyKey: "processing-fee-ownership-0001",
        }),
        stripeClient: stripeSuccess(calls),
        ...stores,
    })

    assert.equal(calls[0].payload.amount, 29200)
    assert.equal(result.refund.customerProcessingFeeCents, 300)
    assert.equal(result.refund.customerRefundableCeilingCents, 29200)
})

test("historical reservation fee snapshot remains authoritative after current settings change", async () => {
    const stores = createStores(hotelReservation({
        amountPaidCents: 30000,
        platformFeeCents: 1000,
        customerPlatformFeeCents: 400,
        businessAbsorbedPlatformFeeCents: 600,
        platformFeeMode: "split",
        customerPlatformFeePercent: 40,
        commissionRateApplied: 2.5,
    }))
    const calls = []

    await cancelHotelReservation({
        ...request({
            clientIdempotencyKey: "historical-fee-snapshot-0001",
        }),
        businessModel: {
            async findOne() {
                throw new Error("current business settings must not be read")
            },
        },
        stripeClient: stripeSuccess(calls),
        ...stores,
    })

    assert.equal(calls[0].payload.amount, 29600)
})

test("previous successful refunds reduce the ceiling and frontend fee tampering is ignored", async () => {
    const stores = createStores(hotelReservation({
        amountPaidCents: 30000,
        platformFeeCents: 1000,
        customerPlatformFeeCents: 400,
        businessAbsorbedPlatformFeeCents: 600,
        refundedAmountCents: 5000,
    }))
    stores.refunds.push({
        _id: "prior-refund",
        refundId: "RF-PRIOR",
        businessId: "hotel-1",
        reservationId: "reservation-1",
        status: "succeeded",
        successfulAmountCents: 5000,
    })
    const calls = []

    await cancelHotelReservation({
        ...request({
            clientIdempotencyKey: "previous-refund-ceiling-0001",
            customerPlatformFeeCents: 0,
            customerProcessingFeeCents: 0,
            customerRefundableCeilingCents: 30000,
        }),
        stripeClient: stripeSuccess(calls),
        ...stores,
    })

    assert.equal(calls[0].payload.amount, 24600)
})

test("partial refund validates balance and persists net-retained state without changing the original paid amount", async () => {
    const stores = createStores(hotelReservation())
    const calls = []
    const result = await cancelHotelReservation({
        ...request({
            outcome: "partial_refund",
            refundAmountCents: 12000,
        }),
        stripeClient: stripeSuccess(calls),
        ...stores,
    })

    assert.equal(calls[0].payload.amount, 12000)
    assert.equal(result.reservation.paymentStatus, "partially_refunded")
    assert.equal(result.reservation.refundedAmountCents, 12000)
    assert.equal(result.reservation.amountPaidCents, 30000)
    assert.equal(
        getRemainingRefundableAmountCents({
            capturedAmountCents: result.reservation.amountPaidCents,
            successfulRefundedAmountCents:
                result.reservation.refundedAmountCents,
        }),
        18000,
    )

    const invalidStores = createStores(
        hotelReservation({ refundedAmountCents: 12000 }),
    )
    await assert.rejects(
        cancelHotelReservation({
            ...request({
                outcome: "partial_refund",
                refundAmountCents: 18001,
                clientIdempotencyKey: "over-refund-operation-0001",
            }),
            stripeClient: stripeSuccess([]),
            ...invalidStores,
        }),
        (error) => error.code === "INVALID_REFUND_AMOUNT",
    )
    assert.equal(invalidStores.refunds.length, 0)

    const stringAmountStores = createStores(hotelReservation())
    await assert.rejects(
        cancelHotelReservation({
            ...request({
                outcome: "partial_refund",
                refundAmountCents: "12000",
                clientIdempotencyKey: "string-refund-operation-0001",
            }),
            stripeClient: stripeSuccess([]),
            ...stringAmountStores,
        }),
        (error) => error.code === "INVALID_REFUND_AMOUNT",
    )

    const feeCeilingStores = createStores(hotelReservation({
        customerPlatformFeeCents: 1000,
        platformFeeCents: 1000,
    }))
    await assert.rejects(
        cancelHotelReservation({
            ...request({
                outcome: "partial_refund",
                refundAmountCents: 29001,
                clientIdempotencyKey: "fee-ceiling-over-refund-0001",
            }),
            stripeClient: stripeSuccess([]),
            ...feeCeilingStores,
        }),
        (error) =>
            error.code === "INVALID_REFUND_AMOUNT" &&
            error.details?.remainingRefundableAmountCents === 29000,
    )
})

test("a repeated successful request and duplicate webhook reconcile one refund only", async () => {
    const stores = createStores(hotelReservation())
    const calls = []
    const input = {
        ...request(),
        stripeClient: stripeSuccess(calls),
        ...stores,
    }
    const first = await cancelHotelReservation(input)
    const retry = await cancelHotelReservation(input)
    const webhookRetry = await reconcileStripeReservationRefund({
        providerRefund: {
            id: first.refund.providerRefundId,
            payment_intent: first.refund.providerPaymentId,
            status: "succeeded",
            metadata: {
                quickServeRefundId: first.refund.refundId,
                reservationId: "reservation-1",
                businessId: "hotel-1",
            },
        },
        ...stores,
    })

    assert.equal(calls.length, 1)
    assert.equal(stores.refunds.length, 1)
    assert.equal(retry.idempotent, true)
    assert.equal(webhookRetry.idempotent, true)
    assert.equal(stores.reservation.refundedAmountCents, 30000)
})

test("webhook metadata and provider payment identifiers must match the stored tenant refund", async () => {
    const stores = createStores(hotelReservation())
    const result = await cancelHotelReservation({
        ...request(),
        stripeClient: stripeSuccess([]),
        ...stores,
    })

    await assert.rejects(
        reconcileStripeReservationRefund({
            providerRefund: {
                id: result.refund.providerRefundId,
                payment_intent: result.refund.providerPaymentId,
                status: "succeeded",
                metadata: {
                    quickServeRefundId: result.refund.refundId,
                    reservationId: "another-reservation",
                    businessId: "hotel-1",
                },
            },
            ...stores,
        }),
        (error) => error.code === "REFUND_METADATA_MISMATCH",
    )
})

test("provider failure leaves the reservation confirmed, records failure, and releases the lock", async () => {
    const stores = createStores(hotelReservation())
    const ownerNotifications = []

    await assert.rejects(
        cancelHotelReservation({
            ...request({
                sendOwnerRefundFailure: async ({ refund }) => {
                    assert.equal(stores.refunds[0].status, "failed")
                    assert.equal(stores.reservation.activeRefundId, null)
                    ownerNotifications.push(refund.refundId)
                    return { created: true }
                },
            }),
            stripeClient: {
                refunds: {
                    async create() {
                        const error = new Error("Refund is not allowed")
                        error.type = "StripeInvalidRequestError"
                        error.code = "refund_not_allowed"
                        error.statusCode = 400
                        throw error
                    },
                },
            },
            ...stores,
        }),
        (error) =>
            error.code === "REFUND_PROVIDER_FAILED" &&
            error.status === 502,
    )

    assert.equal(stores.reservation.status, "confirmed")
    assert.equal(stores.reservation.paymentStatus, "paid")
    assert.equal(stores.reservation.activeRefundId, null)
    assert.equal(stores.refunds[0].status, "failed")
    assert.equal(
        stores.refunds[0].failureCode,
        "refund_not_allowed",
    )
    assert.deepEqual(ownerNotifications, [stores.refunds[0].refundId])
})

test("Stripe refund creation errors distinguish definitive responses from ambiguous outcomes", () => {
    assert.equal(
        classifyStripeRefundCreationError({
            type: "StripeInvalidRequestError",
            statusCode: 400,
        }),
        "definitive",
    )
    assert.equal(
        classifyStripeRefundCreationError({
            type: "StripeConnectionError",
            code: "api_connection_error",
        }),
        "ambiguous",
    )
    assert.equal(
        classifyStripeRefundCreationError({ code: "ETIMEDOUT" }),
        "ambiguous",
    )
    assert.equal(
        classifyStripeRefundCreationError({
            type: "StripeAPIError",
            statusCode: 500,
        }),
        "ambiguous",
    )
})

test("connection and timeout outcomes stay pending, retain the lock, and emit no failure notification", async () => {
    for (const [index, providerError] of [
        Object.assign(new Error("Connection lost"), {
            type: "StripeConnectionError",
            code: "api_connection_error",
        }),
        Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }),
    ].entries()) {
        const stores = createStores(hotelReservation())
        const ownerNotifications = []
        await assert.rejects(
            cancelHotelReservation({
                ...request({
                    clientIdempotencyKey: `ambiguous-refund-${index}-0001`,
                    sendOwnerRefundFailure: async ({ refund }) => {
                        ownerNotifications.push(refund.refundId)
                        return { created: true }
                    },
                }),
                stripeClient: {
                    refunds: {
                        async create() {
                            throw providerError
                        },
                    },
                },
                ...stores,
            }),
            (error) =>
                error.code === "REFUND_PROVIDER_RESULT_UNKNOWN" &&
                error.status === 503 &&
                error.details?.refundPending === true &&
                /being verified/i.test(error.message),
        )

        assert.equal(stores.reservation.status, "confirmed")
        assert.equal(stores.reservation.paymentStatus, "paid")
        assert.equal(
            stores.reservation.activeRefundId,
            stores.refunds[0].refundId,
        )
        assert.equal(stores.refunds[0].status, "pending")
        assert.equal(
            stores.refunds[0].failureCode,
            "provider_result_unknown",
        )
        assert.match(stores.refunds[0].failureMessage, /being verified/i)
        assert.deepEqual(ownerNotifications, [])
    }
})

test("an ambiguous refund safely reconciles from a later Stripe success webhook", async () => {
    const stores = createStores(hotelReservation())
    const ownerNotifications = []
    const ambiguous = Object.assign(new Error("Connection lost"), {
        type: "StripeConnectionError",
    })
    await assert.rejects(
        cancelHotelReservation({
            ...request({
                sendOwnerRefundFailure: async ({ refund }) => {
                    ownerNotifications.push(refund.refundId)
                    return { created: true }
                },
            }),
            stripeClient: {
                refunds: { async create() { throw ambiguous } },
            },
            ...stores,
        }),
        (error) => error.code === "REFUND_PROVIDER_RESULT_UNKNOWN",
    )
    const initial = stores.refunds[0]

    const reconciled = await reconcileStripeReservationRefund({
        providerRefund: {
            id: "re_ambiguous_success",
            payment_intent: initial.providerPaymentId,
            status: "succeeded",
            metadata: {
                quickServeRefundId: initial.refundId,
                reservationId: String(initial.reservationId),
                businessId: initial.businessId,
            },
        },
        sendOwnerRefundFailure: async ({ refund }) => {
            ownerNotifications.push(refund.refundId)
            return { created: true }
        },
        ...stores,
    })

    assert.equal(reconciled.refund.status, "succeeded")
    assert.equal(stores.reservation.status, "cancelled")
    assert.equal(stores.reservation.paymentStatus, "refunded")
    assert.equal(stores.reservation.activeRefundId, null)
    assert.equal(stores.refunds.length, 1)
    assert.deepEqual(ownerNotifications, [])
})

test("an ambiguous refund followed by duplicate failure webhooks emits one failure notification", async () => {
    const stores = createStores(hotelReservation())
    const ownerNotifications = []
    const ambiguous = Object.assign(new Error("Connection lost"), {
        code: "ECONNRESET",
    })
    await assert.rejects(
        cancelHotelReservation({
            ...request(),
            stripeClient: {
                refunds: { async create() { throw ambiguous } },
            },
            ...stores,
        }),
        (error) => error.code === "REFUND_PROVIDER_RESULT_UNKNOWN",
    )
    const initial = stores.refunds[0]
    const providerRefund = {
        id: "re_ambiguous_failed",
        payment_intent: initial.providerPaymentId,
        status: "failed",
        failure_reason: "expired_or_canceled_card",
        metadata: {
            quickServeRefundId: initial.refundId,
            reservationId: String(initial.reservationId),
            businessId: initial.businessId,
        },
    }
    const webhookInput = {
        providerRefund,
        sendOwnerRefundFailure: async ({ refund }) => {
            ownerNotifications.push(refund.refundId)
            return { created: true }
        },
        ...stores,
    }

    const first = await reconcileStripeReservationRefund(webhookInput)
    const duplicate = await reconcileStripeReservationRefund(webhookInput)

    assert.equal(first.refund.status, "failed")
    assert.equal(duplicate.refund.status, "failed")
    assert.equal(stores.reservation.status, "confirmed")
    assert.equal(stores.reservation.activeRefundId, null)
    assert.deepEqual(ownerNotifications, [initial.refundId])
})

test("retrying an ambiguous refund reuses the stored logical refund and Stripe idempotency key", async () => {
    const stores = createStores(hotelReservation())
    const calls = []
    const stripeClient = {
        refunds: {
            async create(payload, options) {
                calls.push({ payload, options })
                if (calls.length === 1) {
                    throw Object.assign(new Error("Connection lost"), {
                        code: "api_connection_error",
                    })
                }
                return {
                    id: "re_recovered_same_attempt",
                    payment_intent: payload.payment_intent,
                    status: "succeeded",
                    metadata: payload.metadata,
                }
            },
        },
    }
    const input = { ...request(), stripeClient, ...stores }

    await assert.rejects(
        cancelHotelReservation(input),
        (error) => error.code === "REFUND_PROVIDER_RESULT_UNKNOWN",
    )
    const initial = stores.refunds[0]
    const retry = await cancelHotelReservation(input)

    assert.equal(retry.refund.status, "succeeded")
    assert.equal(calls.length, 2)
    assert.equal(
        calls[0].options.idempotencyKey,
        calls[1].options.idempotencyKey,
    )
    assert.equal(calls[0].payload.metadata.quickServeRefundId, initial.refundId)
    assert.equal(calls[1].payload.metadata.quickServeRefundId, initial.refundId)
    assert.equal(stores.refunds.length, 1)
})

test("a different user retry cannot bypass an ambiguous refund lock", async () => {
    const stores = createStores(hotelReservation())
    let providerCalls = 0
    const stripeClient = {
        refunds: {
            async create() {
                providerCalls += 1
                throw Object.assign(new Error("Connection lost"), {
                    type: "StripeConnectionError",
                })
            },
        },
    }
    await assert.rejects(
        cancelHotelReservation({
            ...request(),
            stripeClient,
            ...stores,
        }),
        (error) => error.code === "REFUND_PROVIDER_RESULT_UNKNOWN",
    )
    const initial = stores.refunds[0]

    await assert.rejects(
        cancelHotelReservation({
            ...request({
                user: actor("co_owner"),
                clientIdempotencyKey: "different-user-refund-attempt-0002",
            }),
            stripeClient,
            ...stores,
        }),
        (error) => error.code === "CONCURRENT_OPERATION",
    )

    assert.equal(providerCalls, 1)
    assert.equal(stores.reservation.activeRefundId, initial.refundId)
    assert.equal(stores.refunds[0].status, "pending")
    assert.equal(stores.refunds[1].status, "cancelled")
})

test("a concurrent refund cannot acquire the reservation lock or call Stripe twice", async () => {
    const stores = createStores(hotelReservation())
    let releaseProvider
    let providerCalled
    const providerStarted = new Promise((resolve) => {
        providerCalled = resolve
    })
    const providerResult = new Promise((resolve) => {
        releaseProvider = resolve
    })
    let providerCalls = 0
    const stripeClient = {
        refunds: {
            async create(payload) {
                providerCalls += 1
                providerCalled()
                await providerResult
                return {
                    id: "re_concurrent",
                    payment_intent: payload.payment_intent,
                    status: "succeeded",
                    metadata: payload.metadata,
                }
            },
        },
    }
    const first = cancelHotelReservation({
        ...request(),
        stripeClient,
        ...stores,
    })
    await providerStarted

    await assert.rejects(
        cancelHotelReservation({
            ...request({
                clientIdempotencyKey:
                    "second-concurrent-operation-0002",
            }),
            stripeClient,
            ...stores,
        }),
        (error) => error.code === "CONCURRENT_OPERATION",
    )
    releaseProvider()
    const completed = await first

    assert.equal(providerCalls, 1)
    assert.equal(completed.reservation.paymentStatus, "refunded")
    assert.equal(
        stores.refunds.filter((refund) => refund.status === "succeeded")
            .length,
        1,
    )
    assert.equal(
        stores.refunds.filter((refund) => refund.status === "cancelled")
            .length,
        1,
    )
})

test("tenant scoping rejects a reservation owned by another business", async () => {
    const stores = createStores(hotelReservation())

    await assert.rejects(
        cancelHotelReservation({
            ...request({ businessId: "hotel-2" }),
            stripeClient: stripeSuccess([]),
            ...stores,
        }),
        (error) =>
            error.code === "RESERVATION_NOT_FOUND" &&
            error.status === 404,
    )
    assert.equal(stores.refunds.length, 0)
})
