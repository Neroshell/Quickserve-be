import Order from "../models/order.js"
import Reservation from "../models/Reservation.js"
import ReservationRefund from "../models/ReservationRefund.js"

export const TRANSACTION_ORDER_STATUSES = Object.freeze([
    "placed",
    "in_progress",
    "ready",
    "completed",
])

export const TRANSACTION_RESERVATION_STATUSES = Object.freeze([
    "accepted_awaiting_payment",
    "confirmed",
    "checked_in",
    "checked_out",
    "completed",
    "expired",
    "cancelled",
])

function escapeSearchExpression(search) {
    return String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function buildTransactionFilters({ businessId, createdAt, search = "" }) {
    const orderFilter = {
        businessId,
        createdAt,
        status: { $in: [...TRANSACTION_ORDER_STATUSES] },
    }
    const reservationFilter = {
        businessId,
        createdAt,
        totalPrice: { $gt: 0 },
        status: { $in: [...TRANSACTION_RESERVATION_STATUSES] },
    }

    if (search) {
        const searchRegex = new RegExp(escapeSearchExpression(search), "i")
        orderFilter.$or = [
            { orderId: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
        ]
        reservationFilter.$or = [
            { publicReference: { $regex: searchRegex } },
            { customerName: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
        ]
    }

    return { orderFilter, reservationFilter }
}

export function toOrderTransaction(order) {
    return {
        ...order,
        sourceType: "order",
        transactionId: order.orderId,
    }
}

export function toReservationTransaction(reservation, refunds = []) {
    const transactionId =
        reservation.publicReference ||
        `Qsht-${String(reservation._id).slice(-9).toUpperCase()}`
    const legacySubtotal = Number(reservation.totalPrice || 0)
    const subtotal = Number.isFinite(Number(reservation.subtotal))
        ? Number(reservation.subtotal)
        : legacySubtotal
    const originalAmountPaidCents = Number(
        reservation.amountPaidCents ||
        reservation.grossAmount ||
        Math.round(Number(reservation.totalPrice || 0) * 100)
    )
    const refundAdjustments = refunds
        .filter((refund) => refund.status === "succeeded")
        .map((refund) => ({
            refundId: refund.refundId,
            amountCents: Number(refund.successfulAmountCents || 0),
            currency: refund.currency,
            type: refund.type,
            status: refund.status,
            reason: refund.reason,
            refundedAt: refund.succeededAt,
            providerRefundId: refund.providerRefundId,
        }))
    const ledgerRefundedAmountCents = refundAdjustments.reduce(
        (sum, refund) => sum + refund.amountCents,
        0
    )
    const refundedAmountCents = Math.max(
        ledgerRefundedAmountCents,
        Number(reservation.refundedAmountCents || 0)
    )
    const netRetainedAmountCents = Math.max(
        0,
        originalAmountPaidCents - refundedAmountCents
    )
    const hasCapturedPayment = [
        "paid",
        "partially_refunded",
        "refunded",
    ].includes(reservation.paymentStatus)

    return {
        transactionId,
        sourceType: "reservation",
        orderId: transactionId,
        reservationId: reservation._id,
        servicePointLabel: reservation.servicePointLabel || "Hotel reservation",
        customerName: reservation.customerName,
        orderType: "hotel",
        status: reservation.status,
        createdAt: reservation.createdAt,
        updatedAt: reservation.updatedAt,
        paidAt: reservation.paidAt,
        paymentChannel: "online",
        paymentStatus: reservation.paymentStatus,
        paidVia: hasCapturedPayment ? "online_card" : null,
        receiptEmail: reservation.email,
        receiptSent: Boolean(reservation.confirmationEmailSentAt),
        receiptSentAt: reservation.confirmationEmailSentAt || null,
        items: [{
            itemName: `${reservation.servicePointLabel || "Accommodation"} (${reservation.numberOfNights || 1} night${reservation.numberOfNights === 1 ? "" : "s"})`,
            quantity: 1,
            lineTotal: subtotal,
        }],
        subtotal,
        taxRateApplied: Number(reservation.taxRateApplied || 0),
        taxLabel: reservation.taxLabel || "Tax",
        taxAmount: Number(reservation.taxAmount || 0),
        platformFeeLabel: reservation.platformFeeLabel || "Platform Fee",
        platformFeeTotal: Number(reservation.platformFeeTotal || 0),
        platformFeeCents: Number(reservation.platformFeeCents || 0),
        customerPlatformFeeCents: Number(
            reservation.customerPlatformFeeCents || 0
        ),
        businessAbsorbedPlatformFeeCents: Number(
            reservation.businessAbsorbedPlatformFeeCents || 0
        ),
        grossAmount: reservation.grossAmount,
        netToBusinessAmount: reservation.netToBusinessAmount,
        originalAmountPaidCents,
        refundedAmountCents,
        netRetainedAmountCents,
        refundStatus: reservation.paymentStatus,
        lastRefundAt: reservation.lastRefundAt || null,
        refundReason:
            refundAdjustments.at(-1)?.reason ||
            reservation.cancellationReason ||
            null,
        refundAdjustments,
        cancellationOutcome: reservation.cancellationOutcome || null,
        tipAmount: 0,
        total: Number(reservation.totalPrice || 0),
        currency: reservation.currency || null,
        checkInDate: reservation.checkInDate,
        checkOutDate: reservation.checkOutDate,
    }
}

export function createTransactionReadModel({
    orders,
    reservations,
    reservationRefunds = [],
}) {
    const refundsByReservation = new Map()
    for (const refund of reservationRefunds) {
        const key = String(refund.reservationId)
        const rows = refundsByReservation.get(key) || []
        rows.push(refund)
        refundsByReservation.set(key, rows)
    }

    return [
        ...orders.map(toOrderTransaction),
        ...reservations.map((reservation) =>
            toReservationTransaction(
                reservation,
                refundsByReservation.get(String(reservation._id)) || []
            )
        ),
    ].sort(
        (first, second) =>
            new Date(second.updatedAt || second.createdAt) -
            new Date(first.updatedAt || first.createdAt)
    )
}

export async function readOwnerTransactions({
    businessId,
    createdAt,
    search = "",
    orderModel = Order,
    reservationModel = Reservation,
    refundModel = ReservationRefund,
}) {
    const { orderFilter, reservationFilter } = buildTransactionFilters({
        businessId,
        createdAt,
        search,
    })

    const [orders, reservations] = await Promise.all([
        orderModel.find(orderFilter).lean(),
        reservationModel.find(reservationFilter).lean(),
    ])
    const reservationIds = reservations.map(
        (reservation) => reservation._id
    )
    const reservationRefunds = reservationIds.length
        ? await refundModel.find({
              businessId,
              reservationId: { $in: reservationIds },
              status: "succeeded",
          }).lean()
        : []

    return createTransactionReadModel({
        orders,
        reservations,
        reservationRefunds,
    })
}
