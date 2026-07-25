import Order from "../models/order.js"
import Reservation from "../models/Reservation.js"

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

export function toReservationTransaction(reservation) {
    const transactionId =
        reservation.publicReference ||
        `HOTEL-${String(reservation._id).slice(-8).toUpperCase()}`
    const legacySubtotal = Number(reservation.totalPrice || 0)
    const subtotal = Number.isFinite(Number(reservation.subtotal))
        ? Number(reservation.subtotal)
        : legacySubtotal

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
        paidVia: reservation.paymentStatus === "paid" ? "online_card" : null,
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
        tipAmount: 0,
        total: Number(reservation.totalPrice || 0),
        currency: reservation.currency || "EUR",
        checkInDate: reservation.checkInDate,
        checkOutDate: reservation.checkOutDate,
    }
}

export function createTransactionReadModel({ orders, reservations }) {
    return [
        ...orders.map(toOrderTransaction),
        ...reservations.map(toReservationTransaction),
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

    return createTransactionReadModel({ orders, reservations })
}
