import Order from "../models/order.js"
import Reservation from "../models/Reservation.js"
import ReservationRefund from "../models/ReservationRefund.js"
import {
    TRANSACTION_ORDER_STATUSES,
    TRANSACTION_RESERVATION_STATUSES,
    toOrderTransaction,
    toReservationTransaction,
} from "./transactionReadService.js"

export const SOURCE_RANKS = Object.freeze({
    order: 2,
    reservation: 1,
})

function escapeSearchExpression(search) {
    return String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function encodeCursor(transactionAt, sourceType, id) {
    const rank = SOURCE_RANKS[sourceType]
    if (!rank) throw new Error(`Invalid sourceType for cursor: ${sourceType}`)
    const payload = JSON.stringify({
        t: new Date(transactionAt).getTime(),
        r: rank,
        i: String(id),
    })
    return Buffer.from(payload).toString("base64url")
}

export function decodeCursor(cursorString) {
    try {
        const decoded = Buffer.from(cursorString, "base64url").toString("utf-8")
        const parsed = JSON.parse(decoded)
        if (!parsed.t || !parsed.r || !parsed.i) {
            throw new Error("Missing cursor fields")
        }
        return {
            transactionAt: new Date(parsed.t),
            sourceRank: parsed.r,
            id: parsed.i,
        }
    } catch (err) {
        throw new Error("Invalid pagination cursor")
    }
}

function buildCursorConstraint(cursor, targetRank, direction) {
    const { transactionAt, sourceRank, id } = cursor
    const constraints = []

    if (direction === "next") {
        constraints.push({ createdAt: { $lt: transactionAt } })
        if (targetRank < sourceRank) {
            constraints.push({ createdAt: transactionAt })
        }
        if (targetRank === sourceRank) {
            constraints.push({
                createdAt: transactionAt,
                _id: { $lt: id },
            })
        }
    } else {
        constraints.push({ createdAt: { $gt: transactionAt } })
        if (targetRank > sourceRank) {
            constraints.push({ createdAt: transactionAt })
        }
        if (targetRank === sourceRank) {
            constraints.push({
                createdAt: transactionAt,
                _id: { $gt: id },
            })
        }
    }

    return { $or: constraints }
}

function buildBaseFilters({ businessId, dateRangeBounds, search, module, filterBy }) {
    const orderFilter = {
        businessId,
        status: { $in: [...TRANSACTION_ORDER_STATUSES] },
    }
    const reservationFilter = {
        businessId,
        totalPrice: { $gt: 0 },
        status: { $in: [...TRANSACTION_RESERVATION_STATUSES] },
    }

    if (dateRangeBounds) {
        orderFilter.createdAt = dateRangeBounds
        reservationFilter.createdAt = dateRangeBounds
    }

    if (search) {
        const searchRegex = new RegExp(escapeSearchExpression(search), "i")
        orderFilter.$or = [
            { orderId: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
            { displayLabel: { $regex: searchRegex } },
        ]
        reservationFilter.$or = [
            { publicReference: { $regex: searchRegex } },
            { customerName: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
        ]
    }

    if (filterBy && filterBy !== "all") {
        let paymentStatusFilter = null
        let paymentChannelFilter = null
        let paidViaFilter = null

        if (filterBy === "paid") {
            paymentStatusFilter = { $in: ["paid", "partially_refunded", "refunded"] }
        } else if (filterBy === "unpaid") {
            paymentStatusFilter = { $in: ["pending", "unpaid"] }
        } else if (filterBy === "online" || filterBy === "offline") {
            paymentChannelFilter = filterBy
        } else if (["cash", "pos_card", "online_card"].includes(filterBy)) {
            paidViaFilter = filterBy
        }

        if (paymentStatusFilter) {
            orderFilter.paymentStatus = paymentStatusFilter
            reservationFilter.paymentStatus = paymentStatusFilter
        }
        if (paymentChannelFilter) {
            orderFilter.paymentChannel = paymentChannelFilter
            reservationFilter.paymentChannel = paymentChannelFilter
        }
        if (paidViaFilter) {
            orderFilter.paidVia = paidViaFilter
            reservationFilter.paidVia = paidViaFilter
        }
    }

    if (module === "lodging") return { orderFilter: null, reservationFilter }
    if (module === "foodService") return { orderFilter, reservationFilter: null }
    
    return { orderFilter, reservationFilter }
}

export async function aggregateTransactionSummary({ businessId, dateRangeBounds, search, module }) {
    // We explicitly bypass API'status' querying (filterBy="all") so the summary cards
    // can calculate the total revenue accurate pool regardless of the active visual "filter".
    const { orderFilter, reservationFilter } = buildBaseFilters({
        businessId,
        dateRangeBounds,
        search,
        module,
        filterBy: "all"
    })

    const summary = {
        totalRevenue: 0,
        totalQuickServeFees: 0,
        netRevenue: 0,
        totalTips: 0,
        paidOrders: 0,
        pendingOrders: 0,
        onlinePayments: 0,
        offlinePayments: 0
    }

    // Instead of complex mongo aggregations, we do a highly targeted projection query
    // This perfectly matches the frontend's calculation logic while moving the payload off the network
    const [orders, reservations] = await Promise.all([
        orderFilter ? Order.find(orderFilter).select("total tipAmount paymentStatus paymentChannel customerPlatformFeeCents businessAbsorbedPlatformFeeCents platformFeeCents").lean() : [],
        reservationFilter ? Reservation.find(reservationFilter).select("totalPrice subtotal amountPaidCents grossAmount refundedAmountCents customerPlatformFeeCents businessAbsorbedPlatformFeeCents platformFeeCents platformFeeTotal paymentStatus paymentChannel").lean() : []
    ])

    const reservationIds = reservations.map(r => r._id)
    const refunds = reservationIds.length > 0 
        ? await ReservationRefund.find({ businessId, reservationId: { $in: reservationIds }, status: "succeeded" }).select("reservationId successfulAmountCents").lean()
        : []

    const refundsByReservation = new Map()
    for (const refund of refunds) {
        const key = String(refund.reservationId)
        const current = refundsByReservation.get(key) || []
        current.push(refund)
        refundsByReservation.set(key, current)
    }

    const unifiedRows = [
        ...orders.map(o => ({ ...toOrderTransaction(o), sourceType: 'order' })),
        ...reservations.map(r => ({ ...toReservationTransaction(r, refundsByReservation.get(String(r._id)) || []), sourceType: 'reservation' }))
    ]

    let totalRevenue = 0
    let totalQuickServeFeesCents = 0

    unifiedRows.forEach(order => {
        const hasCapturedPayment = ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)
        if (hasCapturedPayment) {
            const tipAmount = Number(order.tipAmount || 0)
            const originalOrderTotal = Math.max(0, (order.total || 0) - tipAmount)
            const orderTotal = order.sourceType === "reservation" && typeof order.netRetainedAmountCents === "number"
                ? order.netRetainedAmountCents / 100
                : originalOrderTotal
                
            const customerFeeCents = order.customerPlatformFeeCents || 0
            const businessFeeCents = order.businessAbsorbedPlatformFeeCents || 0
            const storedFeeCents = order.platformFeeCents || 0
            const quickServeFeeCents = customerFeeCents + businessFeeCents || storedFeeCents
            
            const retainedRatio = originalOrderTotal > 0 ? orderTotal / originalOrderTotal : 0

            totalRevenue += orderTotal
            totalQuickServeFeesCents += Math.round(quickServeFeeCents * retainedRatio)
            summary.totalTips += tipAmount
            summary.paidOrders++
            
            if (order.paymentChannel === "online") summary.onlinePayments += orderTotal
            else summary.offlinePayments += orderTotal
            
        } else if (order.paymentStatus === "pending" || order.paymentStatus === "unpaid") {
            summary.pendingOrders++
        }
    })

    summary.totalRevenue = totalRevenue
    summary.totalQuickServeFees = totalQuickServeFeesCents / 100
    summary.netRevenue = summary.totalRevenue - summary.totalQuickServeFees

    return summary
}

export async function readOwnerTransactionsPage({
    businessId,
    dateRangeBounds,
    search = "",
    module = "overview",
    filterBy = "all",
    limit = 25,
    cursor = null,
    direction = "next",
}) {
    let parsedCursor = null
    if (cursor) {
        try {
            parsedCursor = decodeCursor(cursor)
        } catch (err) {
            const badRequest = new Error("Invalid cursor format")
            badRequest.status = 400
            throw badRequest
        }
        
        if (direction === "previous" && !parsedCursor) {
            const badRequest = new Error("Cannot traverse previous without a valid cursor")
            badRequest.status = 400
            throw badRequest
        }
    }

    const { orderFilter, reservationFilter } = buildBaseFilters({ businessId, dateRangeBounds, search, module, filterBy })

    const orderQuery = orderFilter ? { ...orderFilter } : null
    const resQuery = reservationFilter ? { ...reservationFilter } : null

    if (parsedCursor) {
        if (orderQuery) {
            orderQuery.$and = orderQuery.$and || []
            orderQuery.$and.push(buildCursorConstraint(parsedCursor, SOURCE_RANKS.order, direction))
        }
        if (resQuery) {
            resQuery.$and = resQuery.$and || []
            resQuery.$and.push(buildCursorConstraint(parsedCursor, SOURCE_RANKS.reservation, direction))
        }
    }

    const sortDirection = direction === "next" ? -1 : 1
    const fetchLimit = limit + 1

    const [orderCandidates, resCandidates] = await Promise.all([
        orderQuery ? Order.find(orderQuery).sort({ createdAt: sortDirection, _id: sortDirection }).limit(fetchLimit).lean() : [],
        resQuery ? Reservation.find(resQuery).sort({ createdAt: sortDirection, _id: sortDirection }).limit(fetchLimit).lean() : []
    ])

    const mergedCandidates = []
    for (const doc of orderCandidates) {
        mergedCandidates.push({ doc, rank: SOURCE_RANKS.order, sourceType: "order" })
    }
    for (const doc of resCandidates) {
        mergedCandidates.push({ doc, rank: SOURCE_RANKS.reservation, sourceType: "reservation" })
    }

    mergedCandidates.sort((a, b) => {
        const timeA = new Date(a.doc.createdAt).getTime()
        const timeB = new Date(b.doc.createdAt).getTime()

        if (timeA !== timeB) {
            return direction === "next" ? timeB - timeA : timeA - timeB
        }
        
        if (a.rank !== b.rank) {
            return direction === "next" ? b.rank - a.rank : a.rank - b.rank
        }

        const idA = String(a.doc._id)
        const idB = String(b.doc._id)
        if (idA !== idB) {
            if (direction === "next") {
                return idA < idB ? 1 : -1
            } else {
                return idA > idB ? 1 : -1
            }
        }
        return 0
    })

    const boundedCandidates = mergedCandidates.slice(0, limit + 1)
    
    if (direction === "previous") {
        boundedCandidates.reverse()
    }

    let hasMoreItems = false
    let pageCandidates = boundedCandidates

    if (direction === "next") {
        if (boundedCandidates.length > limit) {
            hasMoreItems = true
            pageCandidates = boundedCandidates.slice(0, limit)
        }
    } else if (direction === "previous") {
        if (boundedCandidates.length > limit) {
            hasMoreItems = true
            pageCandidates = boundedCandidates.slice(1)
        }
    }

    const winningResIds = pageCandidates
        .filter(c => c.sourceType === "reservation")
        .map(c => c.doc._id)

    let refundsByReservation = new Map()
    if (winningResIds.length > 0) {
        const reservationRefunds = await ReservationRefund.find({
            businessId,
            reservationId: { $in: winningResIds },
            status: "succeeded",
        }).lean()

        for (const refund of reservationRefunds) {
            const key = String(refund.reservationId)
            const rows = refundsByReservation.get(key) || []
            rows.push(refund)
            refundsByReservation.set(key, rows)
        }
    }

    const transactions = pageCandidates.map(c => {
        if (c.sourceType === "order") {
            return toOrderTransaction(c.doc)
        } else {
            return toReservationTransaction(
                c.doc,
                refundsByReservation.get(String(c.doc._id)) || []
            )
        }
    })

    let nextCursor = null
    let previousCursor = null

    if (transactions.length > 0) {
        const firstRow = pageCandidates[0]
        const lastRow = pageCandidates[pageCandidates.length - 1]

        const hasNextPage = direction === "next" ? hasMoreItems : parsedCursor !== null
        const hasPreviousPage = direction === "previous" ? hasMoreItems : parsedCursor !== null

        if (hasNextPage) {
            nextCursor = encodeCursor(lastRow.doc.createdAt, lastRow.sourceType, lastRow.doc._id)
        }
        if (hasPreviousPage) {
            previousCursor = encodeCursor(firstRow.doc.createdAt, firstRow.sourceType, firstRow.doc._id)
        }
    }

    const [orderCount, resCount] = await Promise.all([
        orderFilter ? Order.countDocuments(orderFilter) : 0,
        reservationFilter ? Reservation.countDocuments(reservationFilter) : 0
    ])
    const totalCount = orderCount + resCount

    return {
        transactions,
        pagination: {
            nextCursor,
            previousCursor,
            hasNextPage: !!nextCursor,
            hasPreviousPage: !!previousCursor,
            limit,
            totalCount
        }
    }
}
