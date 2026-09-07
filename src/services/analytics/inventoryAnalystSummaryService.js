import InventoryItem from "../../models/InventoryItem.js"
import InventoryMovement from "../../models/InventoryMovement.js"
import InventoryReservation from "../../models/InventoryReservation.js"
import MenuInventoryRecipe from "../../models/MenuInventoryRecipe.js"
import { INVENTORY_MOVEMENT_TYPES } from "../../constants/inventory.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../../constants/menuInventory.js"
import { INVENTORY_SIDECAR_ALLOCATION_STATUSES } from "../../constants/inventoryReservation.js"

export const INVENTORY_ANALYST_LIMITS = Object.freeze({
    maximumUrgentItems: 5,
    maximumAffectedItems: 5,
})

const ADJUSTMENT_TYPES = new Set([
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE,
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
    INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_INCREASE,
    INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_DECREASE,
])

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0
}

function signedInteger(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.round(number) : 0
}

async function resolveLean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

async function aggregateStockHealth(inventoryItemModel, businessId) {
    const rows = await inventoryItemModel.aggregate([
        { $match: { businessId, isActive: true, deletedAt: null } },
        {
            $addFields: {
                availableQuantity: { $subtract: ["$onHandQuantity", "$reservedQuantity"] },
            },
        },
        {
            $addFields: {
                stockRiskRank: {
                    $cond: [
                        { $lte: ["$availableQuantity", 0] },
                        0,
                        {
                            $cond: [
                                { $lte: ["$availableQuantity", "$lowStockThreshold"] },
                                1,
                                2,
                            ],
                        },
                    ],
                },
            },
        },
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: null,
                            activeItems: { $sum: 1 },
                            outOfStockItems: {
                                $sum: { $cond: [{ $lte: ["$availableQuantity", 0] }, 1, 0] },
                            },
                            lowStockItems: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gt: ["$availableQuantity", 0] },
                                                { $lte: ["$availableQuantity", "$lowStockThreshold"] },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
                urgent: [
                    { $match: { stockRiskRank: { $lt: 2 } } },
                    { $sort: { stockRiskRank: 1, availableQuantity: 1, name: 1 } },
                    { $limit: INVENTORY_ANALYST_LIMITS.maximumUrgentItems },
                    {
                        $project: {
                            _id: 0,
                            itemName: "$name",
                            availableQuantity: 1,
                            lowStockThreshold: 1,
                            unit: "$trackingUnit",
                            status: {
                                $cond: [
                                    { $eq: ["$stockRiskRank", 0] },
                                    "out_of_stock",
                                    "low_stock",
                                ],
                            },
                        },
                    },
                ],
            },
        },
    ])

    const result = rows?.[0] || {}
    const summary = result.summary?.[0] || {}
    return {
        activeItems: integer(summary.activeItems),
        lowStockItems: integer(summary.lowStockItems),
        outOfStockItems: integer(summary.outOfStockItems),
        mostUrgentItems: (result.urgent || [])
            .slice(0, INVENTORY_ANALYST_LIMITS.maximumUrgentItems)
            .map((item) => ({
                itemName: String(item.itemName || "").slice(0, 120),
                availableQuantity: integer(item.availableQuantity),
                lowStockThreshold: integer(item.lowStockThreshold),
                unit: String(item.unit || "").slice(0, 20),
                status: item.status === "out_of_stock" ? "out_of_stock" : "low_stock",
            })),
    }
}

async function aggregateMovementRows(inventoryMovementModel, businessId, start, end) {
    return inventoryMovementModel.aggregate([
        { $match: { businessId, createdAt: { $gte: start, $lt: end } } },
        {
            $group: {
                _id: { type: "$type", unit: "$unit" },
                movementCount: { $sum: 1 },
                canonicalQuantity: { $sum: "$canonicalQuantity" },
            },
        },
        { $sort: { "_id.type": 1, "_id.unit": 1 } },
    ])
}

function summarizeMovements(rows = []) {
    const countsByType = {}
    const wasteByUnit = []
    const consumptionByUnit = []
    const adjustments = new Map()
    let totalMovementCount = 0

    for (const row of rows) {
        const type = String(row?._id?.type || "")
        const unit = String(row?._id?.unit || "")
        if (!type || !unit) continue
        const movementCount = integer(row.movementCount)
        const quantity = integer(row.canonicalQuantity)
        totalMovementCount += movementCount
        countsByType[type] = (countsByType[type] || 0) + movementCount

        if (type === INVENTORY_MOVEMENT_TYPES.WASTE) {
            wasteByUnit.push({ unit, movementCount, canonicalQuantity: quantity })
        }
        if (type === INVENTORY_MOVEMENT_TYPES.CONSUME) {
            consumptionByUnit.push({ unit, movementCount, canonicalQuantity: quantity })
        }
        if (ADJUSTMENT_TYPES.has(type)) {
            const value = adjustments.get(unit) || {
                unit,
                movementCount: 0,
                increaseCanonicalQuantity: 0,
                decreaseCanonicalQuantity: 0,
            }
            value.movementCount += movementCount
            if (
                type === INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE ||
                type === INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_INCREASE
            ) {
                value.increaseCanonicalQuantity += quantity
            } else {
                value.decreaseCanonicalQuantity += quantity
            }
            adjustments.set(unit, value)
        }
    }

    const adjustmentsByUnit = [...adjustments.values()]
        .sort((a, b) => a.unit.localeCompare(b.unit))
        .map((row) => ({
            ...row,
            netCanonicalQuantity: signedInteger(
                row.increaseCanonicalQuantity - row.decreaseCanonicalQuantity,
            ),
        }))

    return {
        totalMovementCount,
        countsByType,
        wasteByUnit,
        adjustmentsByUnit,
        consumptionByUnit,
    }
}

async function aggregateShortages(
    inventoryReservationModel,
    inventoryItemModel,
    businessId,
    start,
    end,
) {
    const rows = await inventoryReservationModel.aggregate([
        { $match: { businessId } },
        { $unwind: "$sidecarAllocations" },
        {
            $match: {
                "sidecarAllocations.status": INVENTORY_SIDECAR_ALLOCATION_STATUSES.SHORTAGE,
                "sidecarAllocations.accountedAt": { $gte: start, $lt: end },
            },
        },
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: null,
                            eventCount: { $sum: 1 },
                            affectedItems: { $addToSet: "$sidecarAllocations.inventoryItemId" },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            eventCount: 1,
                            affectedItemCount: { $size: "$affectedItems" },
                        },
                    },
                ],
                byUnit: [
                    {
                        $group: {
                            _id: "$sidecarAllocations.unit",
                            eventCount: { $sum: 1 },
                            shortageCanonicalQuantity: {
                                $sum: "$sidecarAllocations.shortageCanonicalQuantity",
                            },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
                byItem: [
                    {
                        $group: {
                            _id: {
                                inventoryItemId: "$sidecarAllocations.inventoryItemId",
                                unit: "$sidecarAllocations.unit",
                            },
                            eventCount: { $sum: 1 },
                            shortageCanonicalQuantity: {
                                $sum: "$sidecarAllocations.shortageCanonicalQuantity",
                            },
                        },
                    },
                    { $sort: { eventCount: -1, shortageCanonicalQuantity: -1, "_id.inventoryItemId": 1 } },
                    { $limit: INVENTORY_ANALYST_LIMITS.maximumAffectedItems },
                ],
            },
        },
    ])

    const result = rows?.[0] || {}
    const topRows = (result.byItem || []).slice(
        0,
        INVENTORY_ANALYST_LIMITS.maximumAffectedItems,
    )
    const ids = topRows.map((row) => row?._id?.inventoryItemId).filter(Boolean)
    const itemDocs = ids.length > 0
        ? await resolveLean(inventoryItemModel.find(
            { businessId, inventoryItemId: { $in: ids } },
            "inventoryItemId name",
        ))
        : []
    const nameById = new Map(
        (itemDocs || []).map((item) => [item.inventoryItemId, item.name]),
    )
    const summary = result.summary?.[0] || {}

    return {
        eventCount: integer(summary.eventCount),
        affectedItemCount: integer(summary.affectedItemCount),
        quantityByUnit: (result.byUnit || []).map((row) => ({
            unit: String(row._id || "").slice(0, 20),
            eventCount: integer(row.eventCount),
            shortageCanonicalQuantity: integer(row.shortageCanonicalQuantity),
        })),
        mostAffectedItems: topRows.map((row) => ({
            itemName: String(
                nameById.get(row._id.inventoryItemId) || "Tracked inventory item",
            ).slice(0, 120),
            eventCount: integer(row.eventCount),
            shortageCanonicalQuantity: integer(row.shortageCanonicalQuantity),
            unit: String(row._id.unit || "").slice(0, 20),
        })),
    }
}

async function aggregateTracking(menuInventoryRecipeModel, businessId) {
    const rows = await menuInventoryRecipeModel.aggregate([
        { $match: { businessId, archivedAt: null } },
        {
            $group: {
                _id: null,
                activeSimpleStockMappings: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ["$mode", MENU_INVENTORY_MODES.SIMPLE] },
                                    { $eq: ["$status", MENU_INVENTORY_MAPPING_STATUSES.ACTIVE] },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                disabledSimpleStockMappings: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ["$mode", MENU_INVENTORY_MODES.SIMPLE] },
                                    { $eq: ["$status", MENU_INVENTORY_MAPPING_STATUSES.DISABLED] },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                activeIngredientTrackedMenuItems: {
                    $sum: {
                        $cond: [
                            {
                                $or: [
                                    {
                                        $and: [
                                            { $eq: ["$mode", MENU_INVENTORY_MODES.RECIPE] },
                                            { $eq: ["$status", MENU_INVENTORY_MAPPING_STATUSES.ACTIVE] },
                                        ],
                                    },
                                    {
                                        $eq: [
                                            "$ingredientTrackingStatus",
                                            MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
                                        ],
                                    },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                disabledIngredientTrackedMenuItems: {
                    $sum: {
                        $cond: [
                            {
                                $or: [
                                    {
                                        $and: [
                                            { $eq: ["$mode", MENU_INVENTORY_MODES.RECIPE] },
                                            { $eq: ["$status", MENU_INVENTORY_MAPPING_STATUSES.DISABLED] },
                                        ],
                                    },
                                    {
                                        $eq: [
                                            "$ingredientTrackingStatus",
                                            MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
                                        ],
                                    },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ])
    const row = rows?.[0] || {}
    return {
        activeSimpleStockMappings: integer(row.activeSimpleStockMappings),
        disabledSimpleStockMappings: integer(row.disabledSimpleStockMappings),
        activeIngredientTrackedMenuItems: integer(row.activeIngredientTrackedMenuItems),
        disabledIngredientTrackedMenuItems: integer(row.disabledIngredientTrackedMenuItems),
    }
}

function movementCount(summary, types) {
    return types.reduce((total, type) => total + integer(summary.countsByType[type]), 0)
}

/**
 * Build compact Inventory evidence. Mutable stock and tracking state are read
 * only for an explicitly aligned live period. Historical reports use only
 * immutable period-stamped movements and accounted shortage allocations.
 */
export async function buildInventoryAnalystSummary({
    businessId,
    analyticsRange,
    periodAligned = false,
    asOf = new Date(),
    inventoryItemModel = InventoryItem,
    inventoryMovementModel = InventoryMovement,
    inventoryReservationModel = InventoryReservation,
    menuInventoryRecipeModel = MenuInventoryRecipe,
}) {
    if (!businessId) throw new TypeError("businessId is required")
    if (!analyticsRange?.startUtc || !analyticsRange?.endUtcExclusive) {
        throw new TypeError("analyticsRange is required")
    }

    const comparison = analyticsRange.comparison || {}
    const [currentRows, previousRows, currentShortages, previousShortages] = await Promise.all([
        aggregateMovementRows(
            inventoryMovementModel,
            businessId,
            analyticsRange.startUtc,
            analyticsRange.endUtcExclusive,
        ),
        aggregateMovementRows(
            inventoryMovementModel,
            businessId,
            comparison.startUtc,
            comparison.endUtcExclusive,
        ),
        aggregateShortages(
            inventoryReservationModel,
            inventoryItemModel,
            businessId,
            analyticsRange.startUtc,
            analyticsRange.endUtcExclusive,
        ),
        aggregateShortages(
            inventoryReservationModel,
            inventoryItemModel,
            businessId,
            comparison.startUtc,
            comparison.endUtcExclusive,
        ),
    ])

    const [stockHealth, tracking] = periodAligned
        ? await Promise.all([
            aggregateStockHealth(inventoryItemModel, businessId),
            aggregateTracking(menuInventoryRecipeModel, businessId),
        ])
        : [null, null]
    const current = summarizeMovements(currentRows)
    const previous = summarizeMovements(previousRows)
    const adjustmentTypes = [...ADJUSTMENT_TYPES]

    return {
        stockHealthAsOf: stockHealth
            ? {
                asOf: new Date(asOf).toISOString(),
                periodAligned: true,
                ...stockHealth,
            }
            : {
                asOf: new Date(asOf).toISOString(),
                periodAligned: false,
            },
        current: {
            ...current,
            ingredientShortages: currentShortages,
        },
        previous: {
            ...previous,
            ingredientShortages: previousShortages,
        },
        comparison: {
            wasteEventCountDelta:
                movementCount(current, [INVENTORY_MOVEMENT_TYPES.WASTE]) -
                movementCount(previous, [INVENTORY_MOVEMENT_TYPES.WASTE]),
            adjustmentEventCountDelta:
                movementCount(current, adjustmentTypes) -
                movementCount(previous, adjustmentTypes),
            consumptionEventCountDelta:
                movementCount(current, [INVENTORY_MOVEMENT_TYPES.CONSUME]) -
                movementCount(previous, [INVENTORY_MOVEMENT_TYPES.CONSUME]),
            shortageEventCountDelta:
                currentShortages.eventCount - previousShortages.eventCount,
        },
        tracking: tracking
            ? {
                asOf: new Date(asOf).toISOString(),
                periodAligned: true,
                ...tracking,
            }
            : {
                asOf: new Date(asOf).toISOString(),
                periodAligned: false,
            },
    }
}

export default buildInventoryAnalystSummary
