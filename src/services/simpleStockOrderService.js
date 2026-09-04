import crypto from "node:crypto"
import mongoose from "mongoose"

import { INVENTORY_MOVEMENT_TYPES, MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../constants/menuInventory.js"
import {
    ORDER_INVENTORY_AUTHORITIES,
    ORDER_INVENTORY_SEMANTICS,
} from "../constants/orderInventory.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement from "../models/InventoryMovement.js"
import MenuInventoryRecipe from "../models/MenuInventoryRecipe.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import { withCanonicalInventoryTransaction } from "./canonicalInventoryService.js"
import { invalidateMenuItems } from "./cacheInvalidationService.js"
import { assertSimpleStockRuntimeEnabled } from "./inventoryRuntimePolicy.js"
import {
    applyCanonicalSimpleStockProjection,
    resolveManualMenuAvailability,
} from "./menuInventoryAvailabilityService.js"
import {
    buildOrderInventoryDeductionLine,
    buildOrderInventorySemanticsStamp,
    resolveOrderRestorationAuthority,
} from "./orderInventorySemanticsService.js"

const SYSTEM_ORDER_ACTOR = Object.freeze({
    staffId: "system:order-inventory",
    role: "system",
    name: "Order inventory",
})

export class SimpleStockOrderError extends Error {
    constructor(message, {
        code = "SIMPLE_STOCK_ORDER_ERROR",
        statusCode = 409,
        failures = [],
    } = {}) {
        super(message)
        this.name = "SimpleStockOrderError"
        this.code = code
        this.statusCode = statusCode
        this.failures = failures
    }
}

function requiredText(value, field) {
    const normalized = String(value ?? "").trim()
    if (!normalized) {
        throw new SimpleStockOrderError(`${field} is required`, {
            code: "INVALID_SIMPLE_STOCK_ORDER_INPUT",
            statusCode: 400,
        })
    }
    return normalized
}

function normalizeActor(actor) {
    if (!actor) return SYSTEM_ORDER_ACTOR
    return {
        staffId: requiredText(actor.staffId, "actor.staffId"),
        role: requiredText(actor.role, "actor.role"),
        name: requiredText(actor.name, "actor.name"),
    }
}

function hash(value) {
    return crypto.createHash("sha256").update(value).digest("hex")
}

function movementIdentity({ businessId, orderId, menuItemId, action }) {
    const digest = hash(`${businessId}:${orderId}:${menuItemId}:${action}`)
    return {
        movementId: `imv_ord_${digest.slice(0, 24)}`,
        idempotencyKey: `order-inventory:${action}:${digest}`,
    }
}

function movementFingerprint(payload) {
    return hash(JSON.stringify(payload))
}

function positiveOrderQuantity(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
}

function sessionOptions(session) {
    return session ? { session } : undefined
}

function menuItemKey(item) {
    if (item?.menuItemId && mongoose.isValidObjectId(item.menuItemId)) {
        return `id:${String(item.menuItemId)}`
    }
    return `name:${String(item?.itemName ?? "").trim()}`
}

async function resolveRequestedMenuItems({ businessId, items, session }) {
    if (!Array.isArray(items) || items.length === 0) return []
    for (const item of items) {
        if (!positiveOrderQuantity(item?.quantity)) {
            throw new SimpleStockOrderError("Order item quantity is invalid", {
                code: "INVALID_ORDER_ITEM_QUANTITY",
                statusCode: 400,
            })
        }
    }

    const ids = [...new Set(items
        .map((item) => item?.menuItemId)
        .filter((value) => value && mongoose.isValidObjectId(value))
        .map(String))]
    const names = [...new Set(items
        .filter((item) => !item?.menuItemId || !mongoose.isValidObjectId(item.menuItemId))
        .map((item) => String(item?.itemName ?? "").trim())
        .filter(Boolean))]
    const clauses = []
    if (ids.length > 0) clauses.push({ _id: { $in: ids } })
    if (names.length > 0) clauses.push({ name: { $in: names } })
    if (clauses.length === 0) return []

    const menuItems = await MenuItem.find(
        { businessId, archivedAt: null, $or: clauses },
        null,
        sessionOptions(session),
    )
    const byId = new Map(menuItems.map((item) => [String(item._id), item]))
    const byName = new Map()
    for (const item of menuItems) {
        if (!byName.has(item.name)) byName.set(item.name, item)
    }

    const aggregated = new Map()
    for (const requested of items) {
        const resolved = requested.menuItemId
            ? byId.get(String(requested.menuItemId))
            : byName.get(String(requested.itemName ?? "").trim())
        const key = resolved ? String(resolved._id) : menuItemKey(requested)
        const current = aggregated.get(key) || {
            menuItem: resolved || null,
            requested,
            quantity: 0,
        }
        current.quantity += requested.quantity
        if (!Number.isSafeInteger(current.quantity) || current.quantity > MAX_INVENTORY_QUANTITY) {
            throw new SimpleStockOrderError("Aggregated order quantity is too large", {
                code: "INVALID_ORDER_ITEM_QUANTITY",
                statusCode: 400,
            })
        }
        aggregated.set(key, current)
    }
    return [...aggregated.values()]
}

async function resolveDeductionTargets({ businessId, items, session, env }) {
    const requested = await resolveRequestedMenuItems({ businessId, items, session })
    const menuItemIds = requested
        .map((entry) => entry.menuItem?._id)
        .filter(Boolean)
    const mappings = menuItemIds.length > 0
        ? await MenuInventoryRecipe.find({
            businessId,
            menuItemId: { $in: menuItemIds },
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        }, null, sessionOptions(session))
        : []
    const simpleMappings = mappings.filter(
        (mapping) => mapping.mode === MENU_INVENTORY_MODES.SIMPLE,
    )
    if (simpleMappings.length > 0) assertSimpleStockRuntimeEnabled({ env })

    const mappingByMenuItem = new Map(mappings.map((mapping) => [
        String(mapping.menuItemId),
        mapping,
    ]))
    const inventoryItemIds = [...new Set(simpleMappings.map(
        (mapping) => mapping.components?.[0]?.inventoryItemId,
    ).filter(Boolean))]
    const inventoryItems = inventoryItemIds.length > 0
        ? await InventoryItem.find({
            businessId,
            inventoryItemId: { $in: inventoryItemIds },
        }, null, sessionOptions(session))
        : []
    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))

    const targets = []
    const failures = []
    for (const entry of requested) {
        const menuItem = entry.menuItem
        if (!menuItem) {
            failures.push({
                menuItemId: entry.requested?.menuItemId || null,
                itemName: entry.requested?.itemName || "Unknown item",
                requested: entry.quantity,
                available: 0,
                reason: "MENU_ITEM_NOT_FOUND",
            })
            continue
        }
        const mapping = mappingByMenuItem.get(String(menuItem._id))
        if (mapping?.mode === MENU_INVENTORY_MODES.RECIPE) {
            // Phase 3 recipes are configuration and costing definitions only.
            // Phase 4 will reserve their aggregated ingredient requirements.
            // Until then they must never fall through to legacy MenuItem stock.
            if (!resolveManualMenuAvailability(menuItem)) {
                failures.push({
                    menuItemId: menuItem._id,
                    itemName: menuItem.name,
                    requested: entry.quantity,
                    available: 0,
                    reason: "MANUALLY_UNAVAILABLE",
                })
            }
            continue
        }
        if (mapping) {
            const component = mapping.components?.[0]
            const inventoryItem = inventoryById.get(component?.inventoryItemId)
            const requiredQuantity = entry.quantity * Number(component?.canonicalQuantity)
            const validQuantity = Number.isSafeInteger(requiredQuantity) && requiredQuantity > 0
            const validInventory = inventoryItem && inventoryItem.isActive !== false
            const available = validInventory
                ? inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
                : 0
            const manuallyAvailable = resolveManualMenuAvailability(menuItem)
            if (!validQuantity || !validInventory || !manuallyAvailable || available < requiredQuantity) {
                failures.push({
                    menuItemId: menuItem._id,
                    itemName: menuItem.name,
                    requested: validQuantity ? requiredQuantity : entry.quantity,
                    available: Number.isSafeInteger(available) ? Math.max(0, available) : 0,
                    reason: !manuallyAvailable
                        ? "MANUALLY_UNAVAILABLE"
                        : !validInventory
                            ? "CANONICAL_INVENTORY_UNAVAILABLE"
                            : "INSUFFICIENT_CANONICAL_STOCK",
                })
                continue
            }
            targets.push({
                authority: ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM,
                menuItem,
                mapping,
                inventoryItem,
                orderQuantity: entry.quantity,
                canonicalQuantity: requiredQuantity,
            })
            continue
        }

        if (menuItem.trackStock === true && menuItem.stockQuantity !== null) {
            const available = Number.isSafeInteger(menuItem.stockQuantity)
                ? menuItem.stockQuantity
                : 0
            if (available < entry.quantity) {
                failures.push({
                    menuItemId: menuItem._id,
                    itemName: menuItem.name,
                    requested: entry.quantity,
                    available: Math.max(0, available),
                    reason: "INSUFFICIENT_LEGACY_STOCK",
                })
                continue
            }
            targets.push({
                authority: ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
                menuItem,
                orderQuantity: entry.quantity,
            })
        }
    }
    return { targets, failures }
}

async function insertOrderMovement({
    businessId,
    orderId,
    menuItemId,
    inventoryItem,
    canonicalQuantity,
    action,
    actor,
    session,
}) {
    const deduction = action === "deduct"
    const type = deduction
        ? INVENTORY_MOVEMENT_TYPES.LEGACY_ORDER_DEDUCTION
        : INVENTORY_MOVEMENT_TYPES.LEGACY_ORDER_RESTORE
    const direction = deduction ? -1 : 1
    const onHandBefore = inventoryItem.onHandQuantity
    const onHandAfter = onHandBefore + direction * canonicalQuantity
    const { movementId, idempotencyKey } = movementIdentity({
        businessId,
        orderId,
        menuItemId,
        action,
    })
    const fingerprint = movementFingerprint({
        businessId,
        orderId,
        menuItemId: String(menuItemId),
        inventoryItemId: inventoryItem.inventoryItemId,
        type,
        canonicalQuantity,
    })

    inventoryItem.onHandQuantity = onHandAfter
    await inventoryItem.save({ session })
    const [movement] = await InventoryMovement.create([{
        movementId,
        businessId,
        inventoryItemId: inventoryItem.inventoryItemId,
        type,
        quantityDeltaOnHand: direction * canonicalQuantity,
        quantityDeltaReserved: 0,
        unit: inventoryItem.trackingUnit,
        canonicalQuantity,
        onHandBefore,
        onHandAfter,
        reservedBefore: inventoryItem.reservedQuantity,
        reservedAfter: inventoryItem.reservedQuantity,
        sourceType: "order",
        sourceId: orderId,
        reasonCode: deduction ? "order_deduction" : "order_restore",
        performedBy: actor,
        idempotencyKey,
        requestFingerprint: fingerprint,
    }], { session })
    return movement
}

async function findOrderForMutation(orderValue, session) {
    const businessId = requiredText(orderValue?.businessId, "businessId")
    const orderId = requiredText(orderValue?.orderId, "orderId")
    const order = await Order.findOne({ businessId, orderId }, null, { session })
    if (!order) {
        throw new SimpleStockOrderError("Order not found", {
            code: "ORDER_NOT_FOUND",
            statusCode: 404,
        })
    }
    return order
}

async function deductWithinTransaction(orderValue, { session, actor, env }) {
    const order = await findOrderForMutation(orderValue, session)
    if (order.inventoryDeducted) {
        return { changed: false, tracked: true, order }
    }
    const { targets, failures } = await resolveDeductionTargets({
        businessId: order.businessId,
        items: order.items,
        session,
        env,
    })
    if (failures.length > 0) {
        throw new SimpleStockOrderError(
            "Some items are no longer available in the requested quantity",
            { code: "INSUFFICIENT_STOCK", statusCode: 409, failures },
        )
    }
    if (targets.length === 0) return { changed: false, tracked: false, order }

    const performedBy = normalizeActor(actor)
    const lines = []
    for (const target of targets) {
        if (target.authority === ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM) {
            target.menuItem.stockQuantity -= target.orderQuantity
            if (target.menuItem.stockQuantity <= 0) {
                target.menuItem.stockQuantity = 0
                target.menuItem.isAvailable = false
            }
            await target.menuItem.save({ session })
            lines.push(buildOrderInventoryDeductionLine({
                menuItemId: target.menuItem._id,
                authority: target.authority,
                orderQuantity: target.orderQuantity,
            }))
            continue
        }

        const onHandAfter = target.inventoryItem.onHandQuantity - target.canonicalQuantity
        if (onHandAfter < target.inventoryItem.reservedQuantity) {
            throw new SimpleStockOrderError("Insufficient canonical stock", {
                code: "INSUFFICIENT_STOCK",
                statusCode: 409,
            })
        }
        const movement = await insertOrderMovement({
            businessId: order.businessId,
            orderId: order.orderId,
            menuItemId: target.menuItem._id,
            inventoryItem: target.inventoryItem,
            canonicalQuantity: target.canonicalQuantity,
            action: "deduct",
            actor: performedBy,
            session,
        })
        applyCanonicalSimpleStockProjection(target)
        await target.menuItem.save({ session })
        lines.push(buildOrderInventoryDeductionLine({
            menuItemId: target.menuItem._id,
            authority: target.authority,
            orderQuantity: target.orderQuantity,
            inventoryItemId: target.inventoryItem.inventoryItemId,
            canonicalQuantity: target.canonicalQuantity,
            unit: target.inventoryItem.trackingUnit,
            mappingVersion: target.mapping.version,
            deductionMovementId: movement.movementId,
        }))
    }

    const stamp = buildOrderInventorySemanticsStamp(lines)
    order.inventorySemanticsVersion = stamp.inventorySemanticsVersion
    order.inventoryDeductionLines = stamp.inventoryDeductionLines
    order.inventoryDeducted = true
    order.inventoryDeductedAt = new Date()
    await order.save({ session })
    return { changed: true, tracked: true, order }
}

function legacyRestorationInputs(order, semantics) {
    if (semantics.lines.length > 0) return semantics.lines
    const aggregated = new Map()
    for (const item of order.items || []) {
        const key = menuItemKey(item)
        const current = aggregated.get(key) || {
            menuItemId: item.menuItemId || null,
            itemName: item.itemName,
            orderQuantity: 0,
            authority: ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
        }
        current.orderQuantity += item.quantity
        aggregated.set(key, current)
    }
    return [...aggregated.values()]
}

async function restoreWithinTransaction(orderValue, { session, actor }) {
    const order = await findOrderForMutation(orderValue, session)
    if (!order.inventoryDeducted) return { changed: false, tracked: false, order }
    if (order.inventoryRestored) return { changed: false, tracked: true, order }

    const semantics = resolveOrderRestorationAuthority(order)
    const lines = semantics.version === ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1
        ? legacyRestorationInputs(order, semantics)
        : semantics.lines
    const legacyLines = lines.filter(
        (line) => line.authority === ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
    )
    const canonicalLines = lines.filter(
        (line) => line.authority === ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM,
    )
    const performedBy = normalizeActor(actor)

    const legacyMenuItems = []
    for (const line of legacyLines) {
        const query = line.menuItemId
            ? { _id: line.menuItemId, businessId: order.businessId }
            : { name: line.itemName, businessId: order.businessId }
        const menuItem = await MenuItem.findOne(query, null, { session })
        if (!menuItem || menuItem.trackStock !== true || menuItem.stockQuantity === null) {
            throw new SimpleStockOrderError("Legacy restoration target is unavailable", {
                code: "LEGACY_RESTORATION_TARGET_UNAVAILABLE",
            })
        }
        const after = menuItem.stockQuantity + line.orderQuantity
        if (!Number.isSafeInteger(after) || after > MAX_INVENTORY_QUANTITY) {
            throw new SimpleStockOrderError("Legacy restoration would overflow stock", {
                code: "INVENTORY_QUANTITY_OVERFLOW",
            })
        }
        legacyMenuItems.push({ line, menuItem, after })
    }

    const canonicalInventoryItems = []
    for (const line of canonicalLines) {
        const inventoryItem = await InventoryItem.findOne({
            businessId: order.businessId,
            inventoryItemId: line.inventoryItemId,
        }, null, { session })
        if (!inventoryItem) {
            throw new SimpleStockOrderError("Canonical restoration target is unavailable", {
                code: "CANONICAL_RESTORATION_TARGET_UNAVAILABLE",
            })
        }
        const after = inventoryItem.onHandQuantity + line.canonicalQuantity
        if (!Number.isSafeInteger(after) || after > MAX_INVENTORY_QUANTITY) {
            throw new SimpleStockOrderError("Canonical restoration would overflow stock", {
                code: "INVENTORY_QUANTITY_OVERFLOW",
            })
        }
        canonicalInventoryItems.push({ line, inventoryItem })
    }

    for (const entry of legacyMenuItems) {
        entry.menuItem.stockQuantity = entry.after
        if (entry.menuItem.stockQuantity > 0 && entry.menuItem.isAvailable === false) {
            entry.menuItem.isAvailable = true
        }
        await entry.menuItem.save({ session })
    }

    const restoredMovementByMenuItem = new Map()
    for (const entry of canonicalInventoryItems) {
        const movement = await insertOrderMovement({
            businessId: order.businessId,
            orderId: order.orderId,
            menuItemId: entry.line.menuItemId,
            inventoryItem: entry.inventoryItem,
            canonicalQuantity: entry.line.canonicalQuantity,
            action: "restore",
            actor: performedBy,
            session,
        })
        restoredMovementByMenuItem.set(String(entry.line.menuItemId), movement.movementId)

        // Mapping state is consulted only for the compatibility projection. The
        // recorded Order line above is the sole restoration authority.
        const mapping = await MenuInventoryRecipe.findOne({
            businessId: order.businessId,
            menuItemId: entry.line.menuItemId,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
            mode: MENU_INVENTORY_MODES.SIMPLE,
            "components.inventoryItemId": entry.line.inventoryItemId,
        }, null, { session })
        if (mapping) {
            const menuItem = await MenuItem.findOne({
                _id: entry.line.menuItemId,
                businessId: order.businessId,
            }, null, { session })
            if (menuItem) {
                applyCanonicalSimpleStockProjection({ menuItem, inventoryItem: entry.inventoryItem })
                await menuItem.save({ session })
            }
        }
    }

    if (semantics.lines.length > 0) {
        order.inventoryDeductionLines = semantics.lines.map((line) => ({
            ...line,
            restorationMovementId: line.authority === ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM
                ? restoredMovementByMenuItem.get(String(line.menuItemId))
                : null,
        }))
    }
    order.inventoryRestored = true
    order.inventoryRestoredAt = new Date()
    await order.save({ session })
    return { changed: true, tracked: true, order }
}

async function runMutation(work, { session, businessId }) {
    if (session) return work(session)
    const result = await withCanonicalInventoryTransaction(work)
    if (result.changed) await invalidateMenuItems(businessId)
    return result
}

export async function validateSimpleStockOrder(items, businessId, {
    session = null,
    env = process.env,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const { failures } = await resolveDeductionTargets({
        businessId: tenantId,
        items,
        session,
        env,
    })
    return failures
}

export async function deductSimpleStockOrder(orderValue, {
    session = null,
    actor = null,
    env = process.env,
} = {}) {
    const businessId = requiredText(orderValue?.businessId, "businessId")
    const result = await runMutation(
        (transactionSession) => deductWithinTransaction(orderValue, {
            session: transactionSession,
            actor,
            env,
        }),
        { session, businessId },
    )
    return result.tracked
}

export async function restoreSimpleStockOrder(orderValue, {
    session = null,
    actor = null,
} = {}) {
    const businessId = requiredText(orderValue?.businessId, "businessId")
    const result = await runMutation(
        (transactionSession) => restoreWithinTransaction(orderValue, {
            session: transactionSession,
            actor,
        }),
        { session, businessId },
    )
    return result.tracked
}
