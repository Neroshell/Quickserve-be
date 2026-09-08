import mongoose from "mongoose"
import Order from "../models/order.js"

export const OWNER_ORDERS_DEFAULT_LIMIT = 25
export const OWNER_ORDERS_MAX_LIMIT = 25

const OWNER_ORDER_STATUSES = ["placed", "in_progress", "ready", "completed"]
const OWNER_ORDER_TYPES = new Set(["dine-in", "takeout"])
const OWNER_PAYMENT_STATUSES = new Set(["unpaid", "pending", "paid"])
const CURSOR_DIRECTIONS = new Set(["next", "previous"])

const OWNER_ORDER_PROJECTION = {
    _id: 1,
    orderId: 1,
    servicePointId: 1,
    servicePointLabel: 1,
    displayLabel: 1,
    orderType: 1,
    status: 1,
    createdAt: 1,
    updatedAt: 1,
    readyAt: 1,
    items: 1,
    total: 1,
    currency: 1,
    paymentChannel: 1,
    paymentStatus: 1,
    paidVia: 1,
    receiptEmail: 1,
    receiptSent: 1,
    receiptSentAt: 1,
    completedBy: 1,
    subtotal: 1,
    taxAmount: 1,
    platformFeeTotal: 1,
    tipAmount: 1,
    tipType: 1,
    tipPercentage: 1,
    platformFeeCents: 1,
    customerPlatformFeeCents: 1,
    businessAbsorbedPlatformFeeCents: 1,
}

export class OwnerOrdersCursorError extends Error {
    constructor(message = "Invalid owner orders cursor") {
        super(message)
        this.name = "OwnerOrdersCursorError"
        this.statusCode = 400
    }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeLimit(value) {
    if (value === undefined || value === null || value === "") {
        return OWNER_ORDERS_DEFAULT_LIMIT
    }

    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
        return OWNER_ORDERS_DEFAULT_LIMIT
    }

    return Math.min(parsed, OWNER_ORDERS_MAX_LIMIT)
}

export function encodeOwnerOrdersCursor(order) {
    if (!order?.createdAt || !order?._id) {
        return null
    }

    return Buffer.from(JSON.stringify({
        createdAt: new Date(order.createdAt).toISOString(),
        id: String(order._id),
    }), "utf8").toString("base64url")
}

export function decodeOwnerOrdersCursor(value) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        throw new OwnerOrdersCursorError()
    }

    try {
        const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
        const createdAt = new Date(decoded?.createdAt)
        const id = decoded?.id

        if (
            !decoded ||
            typeof decoded !== "object" ||
            Array.isArray(decoded) ||
            typeof decoded.createdAt !== "string" ||
            Number.isNaN(createdAt.getTime()) ||
            typeof id !== "string" ||
            !/^[a-fA-F0-9]{24}$/.test(id)
        ) {
            throw new OwnerOrdersCursorError()
        }

        return {
            createdAt,
            id: new mongoose.Types.ObjectId(id),
        }
    } catch (error) {
        if (error instanceof OwnerOrdersCursorError) throw error
        throw new OwnerOrdersCursorError()
    }
}

function getCursorConstraint(cursor, direction) {
    if (!cursor) return null

    const createdAtOperator = direction === "previous" ? "$gt" : "$lt"
    const idOperator = direction === "previous" ? "$gt" : "$lt"

    return {
        $or: [
            { createdAt: { [createdAtOperator]: cursor.createdAt } },
            {
                createdAt: cursor.createdAt,
                _id: { [idOperator]: cursor.id },
            },
        ],
    }
}

function buildOrdersFilter({
    businessId,
    startDate,
    endDate,
    status,
    search,
    orderType,
    paymentStatus,
    servicePointId,
}) {
    const filter = {
        businessId,
        createdAt: { $gte: startDate, $lt: endDate },
        status: status !== "all" && OWNER_ORDER_STATUSES.includes(status)
            ? status
            : { $in: OWNER_ORDER_STATUSES },
    }

    if (OWNER_ORDER_TYPES.has(orderType)) {
        filter.orderType = orderType
    }
    if (OWNER_PAYMENT_STATUSES.has(paymentStatus)) {
        filter.paymentStatus = paymentStatus
    }
    if (
        typeof servicePointId === "string" &&
        servicePointId.trim() &&
        servicePointId.trim() !== "all"
    ) {
        filter.servicePointLabel = servicePointId.trim()
    }

    const normalizedSearch = typeof search === "string" ? search.trim() : ""
    if (normalizedSearch) {
        const searchRegex = new RegExp(escapeRegex(normalizedSearch), "i")
        filter.$or = [
            { orderId: { $regex: searchRegex } },
            { servicePointLabel: { $regex: searchRegex } },
            { displayLabel: { $regex: searchRegex } },
        ]
    }

    return filter
}

function buildSummary(countRows) {
    return {
        totalOrders: countRows.reduce((total, row) => total + Number(row?.count || 0), 0),
        totalOrderValue: countRows.reduce(
            (total, row) => total + Number(row?.totalOrderValue || 0),
            0,
        ),
    }
}

function buildFilterOptions(metadataRows) {
    const metadata = metadataRows?.[0] || {}
    const orderTypes = Array.isArray(metadata.orderTypes)
        ? metadata.orderTypes.filter((value) => OWNER_ORDER_TYPES.has(value)).sort()
        : []
    const paymentStatuses = Array.isArray(metadata.paymentStatuses)
        ? metadata.paymentStatuses.filter((value) => OWNER_PAYMENT_STATUSES.has(value)).sort()
        : []
    const servicePointsById = new Map()

    for (const servicePoint of metadata.servicePoints || []) {
        const id = typeof servicePoint?.id === "string" ? servicePoint.id.trim() : ""
        if (!id) continue
        const label = typeof servicePoint?.label === "string" && servicePoint.label.trim()
            ? servicePoint.label.trim()
            : id
        servicePointsById.set(id, label)
    }

    return {
        orderTypes,
        paymentStatuses,
        servicePoints: Array.from(servicePointsById, ([id, label]) => ({ id, label }))
            .sort((left, right) => left.label.localeCompare(right.label)),
    }
}

function buildCounts(countRows) {
    const counts = { placed: 0, in_progress: 0, ready: 0, completed: 0 }

    for (const row of countRows) {
        if (row?._id && counts[row._id] !== undefined) {
            counts[row._id] = row.count
        }
    }

    return counts
}

export async function readOwnerOrdersPage({
    businessId,
    startDate,
    endDate,
    status = "all",
    search = "",
    orderType = "all",
    paymentStatus = "all",
    servicePointId = "all",
    cursor: cursorValue,
    direction = "next",
    limit: requestedLimit,
}, { OrderModel = Order } = {}) {
    if (!CURSOR_DIRECTIONS.has(direction)) {
        throw new OwnerOrdersCursorError("Invalid owner orders cursor direction")
    }

    if (direction === "previous" && !cursorValue) {
        throw new OwnerOrdersCursorError("A cursor is required for previous navigation")
    }

    const limit = normalizeLimit(requestedLimit)
    const cursor = cursorValue ? decodeOwnerOrdersCursor(cursorValue) : null
    if (
        cursor &&
        (cursor.createdAt < startDate || cursor.createdAt >= endDate)
    ) {
        throw new OwnerOrdersCursorError("Owner orders cursor does not match the selected date range")
    }
    const baseFilter = buildOrdersFilter({
        businessId,
        startDate,
        endDate,
        status,
        search,
        orderType,
        paymentStatus,
        servicePointId,
    })
    const cursorConstraint = getCursorConstraint(cursor, direction)
    const listFilter = cursorConstraint
        ? { ...baseFilter, $and: [cursorConstraint] }
        : baseFilter
    const countsFilter = {
        businessId,
        createdAt: { $gte: startDate, $lt: endDate },
        status: { $in: OWNER_ORDER_STATUSES },
    }
    const sort = direction === "previous"
        ? { createdAt: 1, _id: 1 }
        : { createdAt: -1, _id: -1 }

    const [rawRows, countRows, metadataRows] = await Promise.all([
        OrderModel.find(listFilter, OWNER_ORDER_PROJECTION)
            .sort(sort)
            .limit(limit + 1)
            .lean(),
        OrderModel.aggregate([
            { $match: countsFilter },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                    totalOrderValue: { $sum: { $ifNull: ["$total", 0] } },
                },
            },
        ]),
        OrderModel.aggregate([
            { $match: countsFilter },
            {
                $group: {
                    _id: null,
                    orderTypes: { $addToSet: "$orderType" },
                    paymentStatuses: { $addToSet: "$paymentStatus" },
                    servicePoints: {
                        $addToSet: {
                            id: "$servicePointLabel",
                            label: "$displayLabel",
                        },
                    },
                },
            },
        ]),
    ])

    const hasExtraRecord = rawRows.length > limit
    let orders = rawRows.slice(0, limit)

    if (direction === "previous") {
        orders = orders.reverse()
    }

    const hasPreviousPage = direction === "previous"
        ? hasExtraRecord
        : Boolean(cursor)
    const hasNextPage = direction === "previous"
        ? Boolean(cursor)
        : hasExtraRecord

    return {
        rawOrders: orders,
        counts: buildCounts(countRows),
        summary: buildSummary(countRows),
        filterOptions: buildFilterOptions(metadataRows),
        pagination: {
            limit,
            nextCursor: hasNextPage && orders.length > 0
                ? encodeOwnerOrdersCursor(orders[orders.length - 1])
                : null,
            previousCursor: hasPreviousPage && orders.length > 0
                ? encodeOwnerOrdersCursor(orders[0])
                : null,
            hasNextPage,
            hasPreviousPage,
        },
    }
}
