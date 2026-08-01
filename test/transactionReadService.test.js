import assert from "node:assert/strict"
import test from "node:test"
import {
    buildTransactionFilters,
    createTransactionReadModel,
    readOwnerTransactions,
    toOrderTransaction,
    toReservationTransaction,
} from "../src/services/transactionReadService.js"

test("order transactions retain their existing payload and gain read-model identity", () => {
    const order = {
        orderId: "ORD-100",
        total: 42,
        createdAt: "2026-07-20T10:00:00.000Z",
    }

    assert.deepEqual(toOrderTransaction(order), {
        ...order,
        sourceType: "order",
        transactionId: "ORD-100",
    })
})

test("reservation transactions preserve the established owner transaction shape", () => {
    const transaction = toReservationTransaction({
        _id: "reservation12345678",
        publicReference: "QS-HOTEL-101",
        servicePointId: "sp_101",
        servicePointLabel: "Suite 101",
        customerName: "Guest One",
        email: "guest@example.com",
        status: "confirmed",
        paymentStatus: "paid",
        confirmationEmailSentAt: "2026-07-20T10:05:00.000Z",
        numberOfNights: 2,
        subtotal: 200,
        totalPrice: 224,
        taxRateApplied: 10,
        taxAmount: 20,
        customerPlatformFeeCents: 400,
        currency: "EUR",
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:05:00.000Z",
    })

    assert.equal(transaction.sourceType, "reservation")
    assert.equal(transaction.transactionId, "QS-HOTEL-101")
    assert.equal(transaction.orderId, "QS-HOTEL-101")
    assert.equal(transaction.servicePointLabel, "Suite 101")
    assert.equal(transaction.paidVia, "online_card")
    assert.equal(transaction.receiptSent, true)
    assert.equal(transaction.items[0].itemName, "Suite 101 (2 nights)")
    assert.equal(transaction.subtotal, 200)
    assert.equal(transaction.total, 224)
    assert.equal(transaction.customerPlatformFeeCents, 400)
})

test("legacy reservations keep totalPrice as their transaction subtotal", () => {
    const transaction = toReservationTransaction({
        _id: "1234567890abcdef",
        totalPrice: 90,
        numberOfNights: 1,
        paymentStatus: "unpaid",
    })

    assert.equal(transaction.transactionId, "Qsht-890ABCDEF")
    assert.equal(transaction.subtotal, 90)
    assert.equal(transaction.items[0].lineTotal, 90)
    assert.equal(transaction.paidVia, null)
    assert.equal(transaction.currency, null)
})

test("reservation refunds remain adjustments while original paid and net-retained amounts stay distinct", () => {
    const transaction = toReservationTransaction(
        {
            _id: "reservation-refunded-1",
            publicReference: "QS-HOTEL-REFUND",
            servicePointLabel: "Suite 8",
            customerName: "Refund Guest",
            status: "cancelled",
            paymentStatus: "partially_refunded",
            amountPaidCents: 30000,
            refundedAmountCents: 12000,
            totalPrice: 300,
            currency: "EUR",
            lastRefundAt: "2026-07-30T12:00:00.000Z",
            cancellationOutcome: "partial_refund",
        },
        [
            {
                refundId: "RF-1",
                status: "succeeded",
                successfulAmountCents: 12000,
                currency: "eur",
                type: "partial",
                reason: "guest_request",
                succeededAt: "2026-07-30T12:00:00.000Z",
                providerRefundId: "re_1",
            },
            {
                refundId: "RF-FAILED",
                status: "failed",
                requestedAmountCents: 1000,
            },
        ],
    )

    assert.equal(transaction.originalAmountPaidCents, 30000)
    assert.equal(transaction.refundedAmountCents, 12000)
    assert.equal(transaction.netRetainedAmountCents, 18000)
    assert.equal(transaction.total, 300)
    assert.equal(transaction.paymentStatus, "partially_refunded")
    assert.equal(transaction.refundAdjustments.length, 1)
    assert.equal(transaction.refundAdjustments[0].refundId, "RF-1")
    assert.equal(transaction.refundReason, "guest_request")
})

test("cancelled paid reservations remain visible as payment-retained transactions", () => {
    const { reservationFilter } = buildTransactionFilters({
        businessId: "business-1",
        createdAt: { $gte: new Date(0), $lt: new Date() },
    })
    const transaction = toReservationTransaction({
        _id: "reservation-retained-1",
        status: "cancelled",
        paymentStatus: "paid",
        amountPaidCents: 20000,
        totalPrice: 200,
        currency: "EUR",
        cancellationOutcome: "no_refund",
    })

    assert.ok(reservationFilter.status.$in.includes("cancelled"))
    assert.equal(transaction.originalAmountPaidCents, 20000)
    assert.equal(transaction.refundedAmountCents, 0)
    assert.equal(transaction.netRetainedAmountCents, 20000)
    assert.equal(transaction.cancellationOutcome, "no_refund")
})

test("transaction filters escape search input and preserve source status rules", () => {
    const createdAt = {
        $gte: new Date("2026-07-20T00:00:00.000Z"),
        $lt: new Date("2026-07-21T00:00:00.000Z"),
    }
    const { orderFilter, reservationFilter } = buildTransactionFilters({
        businessId: "business-1",
        createdAt,
        search: "Suite (1).*",
    })

    assert.equal(orderFilter.businessId, "business-1")
    assert.equal(reservationFilter.totalPrice.$gt, 0)
    assert.equal(orderFilter.$or[0].orderId.$regex.source, "Suite \\(1\\)\\.\\*")
    assert.equal(
        reservationFilter.$or[2].servicePointLabel.$regex.source,
        "Suite \\(1\\)\\.\\*",
    )
    assert.ok(orderFilter.status.$in.includes("completed"))
    assert.ok(reservationFilter.status.$in.includes("checked_in"))
})

test("the combined read model is sorted by latest update without changing source DTOs", () => {
    const transactions = createTransactionReadModel({
        orders: [{
            orderId: "ORD-1",
            createdAt: "2026-07-20T12:00:00.000Z",
        }],
        reservations: [{
            _id: "reservation12345678",
            totalPrice: 100,
            createdAt: "2026-07-20T10:00:00.000Z",
            updatedAt: "2026-07-20T13:00:00.000Z",
        }],
    })

    assert.equal(transactions[0].sourceType, "reservation")
    assert.equal(transactions[1].sourceType, "order")
})

test("owner transaction refund adjustments are loaded with tenant and reservation scope", async () => {
    const queries = []
    function modelReturning(rows, name) {
        return {
            find(filter) {
                queries.push({ name, filter })
                return { lean: async () => rows }
            },
        }
    }
    const reservation = {
        _id: "reservation-tenant-1",
        businessId: "business-1",
        status: "cancelled",
        paymentStatus: "refunded",
        amountPaidCents: 10000,
        refundedAmountCents: 10000,
        totalPrice: 100,
        currency: "EUR",
    }
    const transactions = await readOwnerTransactions({
        businessId: "business-1",
        createdAt: { $gte: new Date(0), $lt: new Date() },
        orderModel: modelReturning([], "order"),
        reservationModel: modelReturning(
            [reservation],
            "reservation",
        ),
        refundModel: modelReturning(
            [
                {
                    reservationId: reservation._id,
                    refundId: "RF-TENANT",
                    status: "succeeded",
                    successfulAmountCents: 10000,
                    currency: "eur",
                },
            ],
            "refund",
        ),
    })

    const refundQuery = queries.find((query) => query.name === "refund")
    assert.equal(refundQuery.filter.businessId, "business-1")
    assert.deepEqual(refundQuery.filter.reservationId.$in, [
        "reservation-tenant-1",
    ])
    assert.equal(refundQuery.filter.status, "succeeded")
    assert.equal(transactions[0].refundAdjustments.length, 1)
})

test("the owner transaction controller loads with the extracted read model", async () => {
    const controller = await import("../src/controllers/ownerController.js")
    assert.equal(typeof controller.ownerTransactions, "function")
})
