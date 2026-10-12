import crypto from "node:crypto"
import mongoose from "mongoose"
import {
    INVENTORY_ITEM_DOMAINS,
    INVENTORY_ITEM_DOMAIN_VALUES,
    INVENTORY_MOVEMENT_TYPE_VALUES,
} from "../constants/inventory.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement from "../models/InventoryMovement.js"
import ServicePoint from "../models/ServicePoint.js"
import {
    toInventoryItemDTO,
    toInventoryMovementDTO,
} from "./canonicalInventoryService.js"
import { INVENTORY_STOCK_STATUSES } from "./inventoryStockStatusService.js"
import { escapeRegex } from "../utils/searchUtils.js"

export const OWNER_INVENTORY_DEFAULT_LIMIT = 25
export const OWNER_INVENTORY_MAX_LIMIT = 100
export const OWNER_INVENTORY_STOCK_STATUSES = Object.freeze({
    ALL: "all",
    LOW_STOCK: INVENTORY_STOCK_STATUSES.LOW_STOCK,
    OUT_OF_STOCK: INVENTORY_STOCK_STATUSES.OUT_OF_STOCK,
})

const MOVEMENT_TYPE_SET = new Set(INVENTORY_MOVEMENT_TYPE_VALUES)
const INVENTORY_DOMAIN_SET = new Set(INVENTORY_ITEM_DOMAIN_VALUES)

export class OwnerInventoryReadError extends Error {
    constructor(message, { code = "INVALID_INVENTORY_QUERY", statusCode = 400 } = {}) {
        super(message)
        this.name = "OwnerInventoryReadError"
        this.code = code
        this.statusCode = statusCode
    }
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

function normalizeDomainFilter(value) {
    const raw = normalizeOptionalFilterText(value, "domain", 500)
    if (!raw || raw === "all") return []
    const domains = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))]
    if (domains.length === 0 || domains.some((domain) => !INVENTORY_DOMAIN_SET.has(domain))) {
        throw new OwnerInventoryReadError("Invalid inventory domain")
    }
    return domains
}

function inventoryDomainCondition(domains) {
    if (domains.length === 0) return null
    const domainConditions = [{ domain: { $in: domains } }]
    if (domains.includes(INVENTORY_ITEM_DOMAINS.FOOD_SERVICE)) {
        domainConditions.push({ domain: { $exists: false } }, { domain: null })
    }
    return { $or: domainConditions }
}

function toInventoryMovementItem(item) {
    if (!item || typeof item !== "object") return null
    if (
        typeof item.inventoryItemId !== "string" ||
        typeof item.name !== "string" ||
        typeof item.trackingUnit !== "string"
    ) {
        return null
    }
    return {
        inventoryItemId: item.inventoryItemId,
        name: item.name,
        category: item.category ?? null,
        trackingUnit: item.trackingUnit,
    }
}

async function enrichInventoryMovements({
    businessId,
    rows,
    InventoryItemModel,
}) {
    const joinedItems = new Map()
    const missingItemIds = new Set()

    for (const row of rows) {
        const joinedItem = toInventoryMovementItem(
            Array.isArray(row.inventoryItem) ? row.inventoryItem[0] : row.inventoryItem,
        )
        if (joinedItem) joinedItems.set(joinedItem.inventoryItemId, joinedItem)
        else if (typeof row.inventoryItemId === "string") missingItemIds.add(row.inventoryItemId)
    }

    if (missingItemIds.size > 0 && typeof InventoryItemModel?.find === "function") {
        const query = InventoryItemModel.find({
            businessId,
            inventoryItemId: { $in: [...missingItemIds] },
        })
        const items = typeof query.lean === "function" ? await query.lean() : await query
        for (const item of items || []) {
            const summary = toInventoryMovementItem(item)
            if (summary) joinedItems.set(summary.inventoryItemId, summary)
        }
    }

    return rows.map((row) => ({
        ...toInventoryMovementDTO(row),
        inventoryItem: joinedItems.get(row.inventoryItemId) || null,
    }))
}

export async function readInventoryOverview({ businessId, domain }, {
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
} = {}) {
    const normalizedDomains = normalizeDomainFilter(domain)
    const domainCondition = inventoryDomainCondition(normalizedDomains)
    const itemMatch = {
        businessId,
        isActive: true,
        deletedAt: null,
        ...(domainCondition || {}),
    }
    const movementPipeline = [
        { $match: { businessId } },
        {
            $lookup: {
                from: InventoryItemModel.collection?.name || "inventoryitems",
                let: { movementInventoryItemId: "$inventoryItemId" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$businessId", businessId] },
                                    { $eq: ["$inventoryItemId", "$$movementInventoryItemId"] },
                                ],
                            },
                        },
                    },
                    ...(domainCondition ? [{ $match: domainCondition }] : []),
                    { $project: { _id: 0, inventoryItemId: 1, name: 1, category: 1, trackingUnit: 1 } },
                    { $limit: 1 },
                ],
                as: "inventoryItem",
            },
        },
        { $match: { "inventoryItem.0": { $exists: true } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: 5 },
    ]
    const recentMovementsQuery = domainCondition
        ? InventoryMovementModel.aggregate(movementPipeline)
        : InventoryMovementModel.find({ businessId })
            .sort({ createdAt: -1, _id: -1 })
            .limit(5)
            .lean()
    const [summaryRows, recentMovementRows] = await Promise.all([
        InventoryItemModel.aggregate([
            { $match: itemMatch },
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
        recentMovementsQuery,
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
        recentMovements: await enrichInventoryMovements({
            businessId,
            rows: recentMovementRows,
            InventoryItemModel,
        }),
    }
}
export async function readInventoryItemsPage({
    businessId,
    active,
    category,
    domain,
    search,
    stockStatus,
    cursor,
    limit,
}, { InventoryItemModel = InventoryItem } = {}) {
    const normalizedActive = normalizeActiveFilter(active)
    const normalizedCategory = normalizeOptionalFilterText(category, "category", 80)
    const normalizedDomains = normalizeDomainFilter(domain)
    const normalizedSearch = normalizeOptionalFilterText(search, "search", 120)
    const normalizedStockStatus = normalizeStockStatusFilter(stockStatus)
    const pageLimit = normalizeLimit(limit)
    const filterKey = queryFingerprint({
        active: normalizedActive,
        category: normalizedCategory.toLowerCase(),
        domains: normalizedDomains,
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
    if (normalizedDomains.length > 0) {
        conditions.push(inventoryDomainCondition(normalizedDomains))
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
    domain,
    cursor,
    limit,
}, {
    InventoryMovementModel = InventoryMovement,
    InventoryItemModel = InventoryItem,
    ServicePointModel = ServicePoint,
} = {}) {
    const normalizedItemId = normalizeOptionalFilterText(
        inventoryItemId,
        "inventoryItemId",
        100,
    )
    const normalizedType = normalizeMovementType(type)
    const normalizedDomains = normalizeDomainFilter(domain)
    const fromDate = normalizeDate(from, "from")
    const toDate = normalizeDate(to, "to")
    if (fromDate && toDate && fromDate > toDate) {
        throw new OwnerInventoryReadError("from cannot be after to")
    }
    const pageLimit = normalizeLimit(limit)
    const filterKey = queryFingerprint({
        inventoryItemId: normalizedItemId,
        type: normalizedType,
        domains: normalizedDomains,
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

    const domainCondition = inventoryDomainCondition(normalizedDomains)
    const rows = domainCondition
        ? await InventoryMovementModel.aggregate([
            { $match: filter },
            {
                $lookup: {
                    from: InventoryItemModel.collection?.name || "inventoryitems",
                    let: { movementInventoryItemId: "$inventoryItemId" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$businessId", businessId] },
                                        { $eq: ["$inventoryItemId", "$$movementInventoryItemId"] },
                                    ],
                                },
                            },
                        },
                        { $match: domainCondition },
                        { $project: { _id: 0, inventoryItemId: 1, name: 1, category: 1, trackingUnit: 1 } },
                        { $limit: 1 },
                    ],
                    as: "inventoryItem",
                },
            },
            { $match: { "inventoryItem.0": { $exists: true } } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: pageLimit + 1 },
        ])
        : await InventoryMovementModel.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .limit(pageLimit + 1)
            .lean()
    const hasNextPage = rows.length > pageLimit
    const pageRows = rows.slice(0, pageLimit)
    const last = pageRows.at(-1)
    const movementDtos = await enrichInventoryMovements({
        businessId,
        rows: pageRows,
        InventoryItemModel,
    })
    const servicePointIds = [...new Set(movementDtos
        .map((movement) => movement.servicePointId)
        .filter(Boolean))]
    const servicePoints = servicePointIds.length > 0
        ? await ServicePointModel.find({
            businessId,
            servicePointId: { $in: servicePointIds },
        }).lean()
        : []
    const servicePointById = new Map(servicePoints.map((servicePoint) => [
        servicePoint.servicePointId,
        servicePoint,
    ]))

    return {
        movements: movementDtos.map((movement) => {
            const servicePoint = movement.servicePointId
                ? servicePointById.get(movement.servicePointId)
                : null
            return servicePoint ? {
                ...movement,
                servicePoint: {
                    servicePointId: servicePoint.servicePointId,
                    label: servicePoint.label,
                    roomType: servicePoint.roomType ?? null,
                },
            } : movement
        }),
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
