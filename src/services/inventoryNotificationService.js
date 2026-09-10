import { NOTIFICATION_TYPES } from "../constants/notifications.js"
import InventoryItem from "../models/InventoryItem.js"
import {
    buildNotificationIdempotencyKey,
    createNotificationEvent,
} from "./notificationService.js"
import {
    INVENTORY_STOCK_STATUSES,
    resolveInventoryStockStatus,
} from "./inventoryStockStatusService.js"

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : { ...value }
}

async function lean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

function validDate(value, fallback) {
    const parsed = value instanceof Date ? new Date(value) : new Date(value || "")
    return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

export function resolveInventoryStockTransition({ movement: movementValue, item: itemValue }) {
    const movement = plain(movementValue)
    const item = plain(itemValue)
    if (!movement || !item) return null

    const before = resolveInventoryStockStatus({
        onHandQuantity: movement.onHandBefore,
        reservedQuantity: movement.reservedBefore,
        lowStockThreshold: item.lowStockThreshold,
    })
    const after = resolveInventoryStockStatus({
        onHandQuantity: movement.onHandAfter,
        reservedQuantity: movement.reservedAfter,
        lowStockThreshold: item.lowStockThreshold,
    })

    let type = null
    if (
        before.status === INVENTORY_STOCK_STATUSES.HEALTHY &&
        after.status === INVENTORY_STOCK_STATUSES.LOW_STOCK
    ) {
        type = NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED
    } else if (
        before.status !== INVENTORY_STOCK_STATUSES.OUT_OF_STOCK &&
        after.status === INVENTORY_STOCK_STATUSES.OUT_OF_STOCK
    ) {
        type = NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED
    }

    if (!type) return null
    return {
        type,
        beforeStatus: before.status,
        afterStatus: after.status,
        availableQuantity: after.availableQuantity,
    }
}

export async function createInventoryStockTransitionNotifications({
    businessId,
    movements: movementValues = [],
    inventoryItems: itemValues = [],
    now = new Date(),
}, {
    InventoryItemModel = InventoryItem,
    createEvent = createNotificationEvent,
    logger = console,
} = {}) {
    const tenantId = String(businessId || "").trim()
    const movements = movementValues.map(plain).filter(Boolean)
    if (movements.length === 0) {
        return { attempted: 0, created: 0, failed: 0, skipped: 0 }
    }

    const itemById = new Map(
        itemValues
            .map(plain)
            .filter((item) => item && (!item.businessId || item.businessId === tenantId))
            .map((item) => [item.inventoryItemId, item]),
    )
    const missingIds = [...new Set(movements
        .map((movement) => movement.inventoryItemId)
        .filter((inventoryItemId) => inventoryItemId && !itemById.has(inventoryItemId)))]
    if (missingIds.length > 0) {
        const found = await lean(InventoryItemModel.find({
            businessId: tenantId,
            inventoryItemId: { $in: missingIds },
        }))
        for (const item of found || []) {
            const value = plain(item)
            itemById.set(value.inventoryItemId, value)
        }
    }

    const summary = { attempted: 0, created: 0, failed: 0, skipped: 0 }
    for (const movement of movements) {
        if (movement.businessId && movement.businessId !== tenantId) {
            summary.skipped += 1
            continue
        }
        const item = itemById.get(movement.inventoryItemId)
        const transition = item
            ? resolveInventoryStockTransition({ movement, item })
            : null
        if (!transition) {
            summary.skipped += 1
            continue
        }

        summary.attempted += 1
        const entityId = String(item.inventoryItemId || "").trim()
        const occurrenceId = String(movement.movementId || movement._id || "").trim()
        try {
            const result = await createEvent({
                businessId: tenantId,
                type: transition.type,
                entityId,
                occurredAt: validDate(movement.createdAt, now),
                idempotencyKey: buildNotificationIdempotencyKey({
                    type: transition.type,
                    entityId,
                    occurrenceId,
                }),
                facts: {
                    itemName: item.name,
                    availableQuantity: transition.availableQuantity,
                    trackingUnit: item.trackingUnit,
                },
            })
            if (result?.created !== false) summary.created += 1
        } catch (error) {
            summary.failed += 1
            logger?.error?.("[inventory-notification] Notification intent failed", {
                businessId: tenantId,
                inventoryItemId: entityId,
                movementId: occurrenceId,
                errorClass: error?.name || "Error",
            })
        }
    }
    return summary
}
