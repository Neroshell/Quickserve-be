import crypto from "node:crypto"
import mongoose from "mongoose"
import { INVENTORY_MOVEMENT_TYPE_VALUES } from "../constants/inventory.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement from "../models/InventoryMovement.js"
import {
    toInventoryItemDTO,
    toInventoryMovementDTO,
} from "./canonicalInventoryService.js"

export const OWNER_INVENTORY_DEFAULT_LIMIT = 25
export const OWNER_INVENTORY_MAX_LIMIT = 100
export const OWNER_INVENTORY_STOCK_STATUSES = Object.freeze({
    ALL: "all",
    LOW_STOCK: "low_stock",
    OUT_OF_STOCK: "out_of_stock",
})

const MOVEMENT_TYPE_SET = new Set(INVENTORY_MOVEMENT_TYPE_VALUES)

export class OwnerInventoryReadError extends Error {
    constructor(message, { code = "INVALID_INVENTORY_QUERY", statusCode = 400 } = {}) {
        super(message)
        this.name = "OwnerInventoryReadError"
        this.code = code
        this.statusCode = statusCode
    }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeLimit(value) {
    if (value === undefined || value === null || value === "") {
        return OWNER_INVENTORY_DEFAULT_LIMIT
    }
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        throw new OwnerInventoryReadError("limit must be a positive integer")
    }
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new OwnerInventoryReadError("limit must be a positive integer")
    }
    return Math.min(parsed, OWNER_INVENTORY_MAX_LIMIT)
}

function normalizeOptionalFilterText(value, field, maxLength = 120) {
    if (value === undefined || value === null || value === "") return ""
    if (typeof value !== "string") {
        throw new OwnerInventoryReadError(`${field} must be a string`)
    }
    const normalized = value.trim()
    if (normalized.length > maxLength) {
        throw new OwnerInventoryReadError(`${field} is too long`)
    }
    return normalized
}

function queryFingerprint(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(value, expectedKind, expectedFilterKey) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 768 ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        throw new OwnerInventoryReadError("Invalid inventory cursor")
    }

    try {
        const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
        if (
            !decoded ||
            typeof decoded !== "object" ||
            Array.isArray(decoded) ||
            decoded.kind !== expectedKind ||
            decoded.filterKey !== expectedFilterKey ||
            typeof decoded.id !== "string" ||
            !mongoose.isValidObjectId(decoded.id)
        ) {
            throw new OwnerInventoryReadError("Inventory cursor does not match this query")
        }
        return decoded
    } catch (error) {
        if (error instanceof OwnerInventoryReadError) throw error
        throw new OwnerInventoryReadError("Invalid inventory cursor")
    }
}

function normalizeActiveFilter(value) {
    if (value === undefined || value === null || value === "" || value === "all") return "all"
    if (value === true || value === "true") return true
    if (value === false || value === "false") return false
    throw new OwnerInventoryReadError("active must be true, false, or all")
}

function normalizeStockStatusFilter(value) {
    if (value === undefined || value === null || value === "" || value === "all") {
        return OWNER_INVENTORY_STOCK_STATUSES.ALL
    }
    if (
        value === OWNER_INVENTORY_STOCK_STATUSES.LOW_STOCK ||
        value === OWNER_INVENTORY_STOCK_STATUSES.OUT_OF_STOCK
    ) {
        return value
    }
    throw new OwnerInventoryReadError("stockStatus must be all, low_stock, or out_of_stock")
}

export async function readInventoryOverview({ businessId }, {
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
} = {}) {
    const [summaryRows, recentMovements] = await Promise.all([
        InventoryItemModel.aggregate([
            { $match: { businessId, isActive: true, deletedAt: null } },
            {
                $project: {
                    availableQuantity: { $subtract: ["$onHandQuantity", "$reservedQuantity"] },
                    lowStockThreshold: 1,
                },
            },
            {
                $group: {
                    _id: null,
                    activeItems: { $sum: 1 },
                    outOfStockItems: {
                        $sum: { $cond: [{ $lte: ["$availableQuantity", 0] }, 1, 0] },
                    },
                    lowStockItems: {
                        $sum: {
                            $cond: [{
                                $and: [
                                    { $gt: ["$availableQuantity", 0] },
                                    { $lte: ["$availableQuantity", "$lowStockThreshold"] },
                                ],
                            }, 1, 0],
                        },
                    },
                },
            },
        ]),
        InventoryMovementModel.find({ businessId })
            .sort({ createdAt: -1, _id: -1 })
            .limit(10)
            .lean(),
    ])

    const summary = summaryRows[0] || {
        activeItems: 0,
        outOfStockItems: 0,
        lowStockItems: 0,
    }
    return {
        summary: {
            activeItems: summary.activeItems,
            lowStockItems: summary.lowStockItems,
            outOfStockItems: summary.outOfStockItems,
        },
        recentMovements: recentMovements.map(toInventoryMovementDTO),
    }
}

export async function readInventoryItemsPage({
    businessId,
    active,
    category,
    search,
    stockStatus,
    cursor,
    limit,
}, { InventoryItemModel = InventoryItem } = {}) {
    const normalizedActive = normalizeActiveFilter(active)
    const normalizedCategory = normalizeOptionalFilterText(category, "category", 80)
    const normalizedSearch = normalizeOptionalFilterText(search, "search", 120)
    const normalizedStockStatus = normalizeStockStatusFilter(stockStatus)
    const pageLimit = normalizeLimit(limit)
    const filterKey = queryFingerprint({
        active: normalizedActive,
        category: normalizedCategory.toLowerCase(),
        search: normalizedSearch.toLowerCase(),
        stockStatus: normalizedStockStatus,
    })
    const decodedCursor = cursor
        ? decodeCursor(cursor, "inventory_items", filterKey)
        : null

    const filter = { businessId, deletedAt: null }
    if (normalizedActive !== "all") filter.isActive = normalizedActive
    const conditions = []
    if (normalizedCategory) {
        conditions.push({
            category: { $regex: new RegExp(`^${escapeRegex(normalizedCategory)}$`, "i") },
        })
    }
    if (normalizedSearch) {
        conditions.push({
            $or: [
                { name: { $regex: new RegExp(escapeRegex(normalizedSearch), "i") } },
                { category: { $regex: new RegExp(escapeRegex(normalizedSearch), "i") } },
            ],
        })
    }
    const availableQuantityExpression = {
        $subtract: ["$onHandQuantity", "$reservedQuantity"],
    }
    if (normalizedStockStatus === OWNER_INVENTORY_STOCK_STATUSES.LOW_STOCK) {
        conditions.push({
            $expr: {
                $and: [
                    { $gt: [availableQuantityExpression, 0] },
                    { $lte: [availableQuantityExpression, "$lowStockThreshold"] },
                ],
            },
        })
    }
    if (normalizedStockStatus === OWNER_INVENTORY_STOCK_STATUSES.OUT_OF_STOCK) {
        conditions.push({
            $expr: { $lte: [availableQuantityExpression, 0] },
        })
    }
    if (decodedCursor) {
        if (typeof decodedCursor.name !== "string") {
            throw new OwnerInventoryReadError("Invalid inventory cursor")
        }
        conditions.push({
            $or: [
                { name: { $gt: decodedCursor.name } },
                {
                    name: decodedCursor.name,
                    _id: { $gt: new mongoose.Types.ObjectId(decodedCursor.id) },
                },
            ],
        })
    }
    if (conditions.length > 0) filter.$and = conditions

    const rows = await InventoryItemModel.find(filter)
        .sort({ name: 1, _id: 1 })
        .limit(pageLimit + 1)
        .lean()
    const hasNextPage = rows.length > pageLimit
    const pageRows = rows.slice(0, pageLimit)
    const last = pageRows.at(-1)

    return {
        items: pageRows.map(toInventoryItemDTO),
        pagination: {
            limit: pageLimit,
            hasNextPage,
            nextCursor: hasNextPage && last
                ? encodeCursor({
                    kind: "inventory_items",
                    filterKey,
                    name: last.name,
                    id: String(last._id),
                })
                : null,
        },
    }
}

export async function readInventoryItem({ businessId, inventoryItemId }, {
    InventoryItemModel = InventoryItem,
} = {}) {
    const item = await InventoryItemModel.findOne({ businessId, inventoryItemId }).lean()
    if (!item) {
        throw new OwnerInventoryReadError("Inventory item not found", {
            code: "INVENTORY_ITEM_NOT_FOUND",
            statusCode: 404,
        })
    }
    return toInventoryItemDTO(item)
}

function normalizeMovementType(value) {
    const type = normalizeOptionalFilterText(value, "type", 80)
    if (!type) return ""
    if (!MOVEMENT_TYPE_SET.has(type)) {
        throw new OwnerInventoryReadError("Invalid inventory movement type")
    }
    return type
}

function normalizeDate(value, field) {
    if (value === undefined || value === null || value === "") return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        throw new OwnerInventoryReadError(`${field} must be a valid date`)
    }
    return date
}

export async function readInventoryMovementsPage({
    businessId,
    inventoryItemId,
    type,
    from,
    to,
    cursor,
    limit,
}, { InventoryMovementModel = InventoryMovement } = {}) {
    const normalizedItemId = normalizeOptionalFilterText(
        inventoryItemId,
        "inventoryItemId",
        100,
    )
    const normalizedType = normalizeMovementType(type)
    const fromDate = normalizeDate(from, "from")
    const toDate = normalizeDate(to, "to")
    if (fromDate && toDate && fromDate > toDate) {
        throw new OwnerInventoryReadError("from cannot be after to")
    }
    const pageLimit = normalizeLimit(limit)
    const filterKey = queryFingerprint({
        inventoryItemId: normalizedItemId,
        type: normalizedType,
        from: fromDate?.toISOString() || null,
        to: toDate?.toISOString() || null,
    })
    const decodedCursor = cursor
        ? decodeCursor(cursor, "inventory_movements", filterKey)
        : null

    const filter = { businessId }
    if (normalizedItemId) filter.inventoryItemId = normalizedItemId
    if (normalizedType) filter.type = normalizedType
    if (fromDate || toDate) {
        filter.createdAt = {}
        if (fromDate) filter.createdAt.$gte = fromDate
        if (toDate) filter.createdAt.$lte = toDate
    }
    if (decodedCursor) {
        const createdAt = new Date(decodedCursor.createdAt)
        if (Number.isNaN(createdAt.getTime())) {
            throw new OwnerInventoryReadError("Invalid inventory cursor")
        }
        filter.$or = [
            { createdAt: { $lt: createdAt } },
            {
                createdAt,
                _id: { $lt: new mongoose.Types.ObjectId(decodedCursor.id) },
            },
        ]
    }

    const rows = await InventoryMovementModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageLimit + 1)
        .lean()
    const hasNextPage = rows.length > pageLimit
    const pageRows = rows.slice(0, pageLimit)
    const last = pageRows.at(-1)

    return {
        movements: pageRows.map(toInventoryMovementDTO),
        pagination: {
            limit: pageLimit,
            hasNextPage,
            nextCursor: hasNextPage && last
                ? encodeCursor({
                    kind: "inventory_movements",
                    filterKey,
                    createdAt: new Date(last.createdAt).toISOString(),
                    id: String(last._id),
                })
                : null,
        },
    }
}
