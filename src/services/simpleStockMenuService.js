import crypto from "node:crypto"
import mongoose from "mongoose"

import { MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
    SIMPLE_STOCK_UNIT_VALUES,
} from "../constants/menuInventory.js"
import { ORDER_INVENTORY_SEMANTICS } from "../constants/orderInventory.js"
import InventoryItem from "../models/InventoryItem.js"
import MenuInventoryRecipe from "../models/MenuInventoryRecipe.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import {
    adjustInventory,
    withCanonicalInventoryTransaction,
} from "./canonicalInventoryService.js"
import { invalidateMenuMutation } from "./cacheInvalidationService.js"
import {
    applyCanonicalSimpleStockProjection,
    resolveManualMenuAvailability,
    toMenuItemWithInventoryDTO,
} from "./menuInventoryAvailabilityService.js"
import { normalizeMenuFulfillmentConfiguration } from "./orderFulfillmentService.js"

const SIMPLE_UNITS = new Set(SIMPLE_STOCK_UNIT_VALUES)

export class SimpleStockMenuError extends Error {
    constructor(message, code = "SIMPLE_STOCK_MENU_ERROR", statusCode = 400) {
        super(message)
        this.name = "SimpleStockMenuError"
        this.code = code
        this.statusCode = statusCode
    }
}

function requiredText(value, field, maxLength = 200) {
    const normalized = String(value ?? "").trim()
    if (!normalized || normalized.length > maxLength) {
        throw new SimpleStockMenuError(`${field} is required`, "INVALID_SIMPLE_STOCK_INPUT")
    }
    return normalized
}

function nonNegativeInteger(value, field) {
    const number = typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : value
    if (!Number.isSafeInteger(number) || number < 0 || number > MAX_INVENTORY_QUANTITY) {
        throw new SimpleStockMenuError(
            `${field} must be a non-negative whole number`,
            "INVALID_SIMPLE_STOCK_INPUT",
        )
    }
    return number
}

function normalizeActor(actor) {
    return {
        staffId: requiredText(actor?.staffId, "actor.staffId"),
        role: requiredText(actor?.role, "actor.role", 80),
        name: requiredText(actor?.name, "actor.name", 160),
    }
}

function digestFor(businessId, idempotencyKey) {
    return crypto.createHash("sha256").update(`${businessId}:${idempotencyKey}`).digest("hex")
}

function simpleCreationIdentities(businessId, idempotencyKey) {
    const digest = digestFor(businessId, idempotencyKey)
    return {
        menuObjectId: new mongoose.Types.ObjectId(digest.slice(0, 24)),
        inventoryItemId: `inv_menu_${digest.slice(0, 24)}`,
        mappingId: `mir_menu_${digest.slice(0, 24)}`,
        openingMovementId: `imv_menu_${digest.slice(0, 24)}`,
    }
}

async function loadSimpleMapping({ businessId, menuItemId, session, activeOnly = false }) {
    const query = {
        businessId,
        menuItemId,
        mode: MENU_INVENTORY_MODES.SIMPLE,
    }
    if (activeOnly) query.status = MENU_INVENTORY_MAPPING_STATUSES.ACTIVE
    const mapping = await MenuInventoryRecipe.findOne(query, null, { session })
    if (!mapping) {
        throw new SimpleStockMenuError(
            "Simple Stock mapping not found",
            "SIMPLE_STOCK_MAPPING_NOT_FOUND",
            404,
        )
    }
    return mapping
}

async function loadMappedRecords({ businessId, menuItemId, session, activeOnly = false }) {
    const mapping = await loadSimpleMapping({ businessId, menuItemId, session, activeOnly })
    const [menuItem, inventoryItem] = await Promise.all([
        MenuItem.findOne({ _id: menuItemId, businessId, archivedAt: null }, null, { session }),
        InventoryItem.findOne({
            businessId,
            inventoryItemId: mapping.components[0].inventoryItemId,
        }, null, { session }),
    ])
    if (!menuItem || !inventoryItem) {
        throw new SimpleStockMenuError(
            "Simple Stock linkage is incomplete",
            "SIMPLE_STOCK_LINKAGE_BROKEN",
            409,
        )
    }
    return { mapping, menuItem, inventoryItem }
}

export async function enrichMenuItemsWithInventory({ businessId, menuItems }) {
    const tenantId = requiredText(businessId, "businessId")
    const values = Array.isArray(menuItems) ? menuItems : []
    if (values.length === 0) return []
    const menuItemIds = values
        .map((item) => item._id || item.id)
        .filter((value) => value && mongoose.isValidObjectId(value))
    const mappings = await MenuInventoryRecipe.find({
        businessId: tenantId,
        menuItemId: { $in: menuItemIds },
        status: { $ne: MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED },
    }).lean()
    const mappingByMenu = new Map(mappings.map((mapping) => [String(mapping.menuItemId), mapping]))
    const inventoryIds = [...new Set(mappings.flatMap(
        (mapping) => (mapping.components || []).map((component) => component.inventoryItemId),
    ).filter(Boolean))]
    const inventoryItems = inventoryIds.length > 0
        ? await InventoryItem.find({
            businessId: tenantId,
            inventoryItemId: { $in: inventoryIds },
        }).lean()
        : []
    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))

    return values.map((value) => {
        const plain = typeof value?.toObject === "function"
            ? value.toObject({ depopulate: true })
            : value
        const mapping = mappingByMenu.get(String(plain._id)) || null
        const mappedInventoryItems = mapping
            ? (mapping.components || []).map(
                (component) => inventoryById.get(component.inventoryItemId),
            ).filter(Boolean)
            : []
        const inventoryItem = mapping?.mode === MENU_INVENTORY_MODES.SIMPLE
            ? mappedInventoryItems[0] || null
            : null
        return toMenuItemWithInventoryDTO({
            menuItem: plain,
            mapping,
            inventoryItem,
            inventoryItems: mappedInventoryItems,
        })
    })
}

export async function createSimpleStockMenuItem({
    businessId,
    input,
    actor,
    idempotencyKey,
}) {
    const tenantId = requiredText(businessId, "businessId")
    const key = requiredText(idempotencyKey, "Idempotency-Key")
    const performedBy = normalizeActor(actor)
    const unit = requiredText(input?.stockUnit, "stockUnit", 20)
    if (!SIMPLE_UNITS.has(unit)) {
        throw new SimpleStockMenuError(
            "Simple Stock supports piece, bottle, can, pack, or portion",
            "INVALID_SIMPLE_STOCK_UNIT",
        )
    }
    const openingQuantity = nonNegativeInteger(input?.openingQuantity ?? 0, "openingQuantity")
    const lowStockThreshold = nonNegativeInteger(input?.lowStockThreshold ?? 0, "lowStockThreshold")
    const price = Number(input?.price)
    if (!Number.isFinite(price) || price < 0) {
        throw new SimpleStockMenuError("price must be a non-negative number", "INVALID_SIMPLE_STOCK_INPUT")
    }
    const description = String(input?.description || "")
    if (description.trim().split(/\s+/).filter(Boolean).length > 100) {
        throw new SimpleStockMenuError("Description must be 100 words or less", "INVALID_SIMPLE_STOCK_INPUT")
    }
    const identities = simpleCreationIdentities(tenantId, key)
    const fulfillment = normalizeMenuFulfillmentConfiguration({
        type: input?.type,
        fulfillmentStation: input?.fulfillmentStation,
        fulfillmentBehavior: input?.fulfillmentBehavior,
        prepTimeMinutes: input?.prepTimeMinutes,
    })
    const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({
        businessId: tenantId,
        name: input?.name,
        price,
        prepTimeMinutes: fulfillment.prepTimeMinutes,
        category: input?.category,
        type: input?.type,
        fulfillmentStation: fulfillment.fulfillmentStation,
        fulfillmentBehavior: fulfillment.fulfillmentBehavior,
        description,
        imageUrl: input?.imageUrl || "",
        isAvailable: input?.isAvailable !== false,
        openingQuantity,
        lowStockThreshold,
        unit,
    })).digest("hex")

    const result = await withCanonicalInventoryTransaction(async (session) => {
        const replay = await MenuItem.findOne({ _id: identities.menuObjectId, businessId: tenantId }, null, { session })
        if (replay) {
            const records = await loadMappedRecords({
                businessId: tenantId,
                menuItemId: replay._id,
                session,
            })
            if (
                records.mapping.menuInventoryRecipeId !== identities.mappingId ||
                records.inventoryItem.inventoryItemId !== identities.inventoryItemId ||
                records.mapping.creationRequestFingerprint !== requestFingerprint
            ) {
                throw new SimpleStockMenuError(
                    "Idempotency-Key conflicts with another menu item",
                    "SIMPLE_STOCK_IDEMPOTENCY_CONFLICT",
                    409,
                )
            }
            return { replayed: true, menuItem: replay }
        }

        const manualIsAvailable = input?.isAvailable !== false
        const [menuItem] = await MenuItem.create([{
            _id: identities.menuObjectId,
            businessId: tenantId,
            name: requiredText(input?.name, "name", 30),
            price,
            prepTimeMinutes: fulfillment.prepTimeMinutes,
            category: requiredText(input?.category, "category", 80),
            type: fulfillment.type,
            fulfillmentStation: fulfillment.fulfillmentStation,
            fulfillmentBehavior: fulfillment.fulfillmentBehavior,
            description,
            imageUrl: input?.imageUrl || "",
            manualIsAvailable,
            isAvailable: manualIsAvailable && openingQuantity > 0,
            trackStock: true,
            stockQuantity: openingQuantity,
            lowStockThreshold,
        }], { session })
        const [inventoryItem] = await InventoryItem.create([{
            inventoryItemId: identities.inventoryItemId,
            businessId: tenantId,
            name: menuItem.name,
            category: menuItem.category,
            trackingUnit: unit,
            baseUnitDimension: "count",
            onHandQuantity: 0,
            reservedQuantity: 0,
            lowStockThreshold,
            isActive: true,
        }], { session })
        if (openingQuantity > 0) {
            await adjustInventory({
                businessId: tenantId,
                inventoryItemId: inventoryItem.inventoryItemId,
                input: {
                    quantity: openingQuantity,
                    unit,
                    direction: "increase",
                    reason: "opening_balance_correction",
                    reference: `menu-item:${menuItem._id}`,
                    note: "New Simple Stock item opening balance",
                },
                actor: performedBy,
                idempotencyKey: `simple-stock-create:${key}:opening`,
                session,
            }, { generateMovementId: () => identities.openingMovementId })
            inventoryItem.onHandQuantity = openingQuantity
        }
        await MenuInventoryRecipe.create([{
            menuInventoryRecipeId: identities.mappingId,
            businessId: tenantId,
            menuItemId: menuItem._id,
            mode: MENU_INVENTORY_MODES.SIMPLE,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
            version: 1,
            creationRequestFingerprint: requestFingerprint,
            components: [{
                inventoryItemId: inventoryItem.inventoryItemId,
                quantity: 1,
                unit,
                canonicalQuantity: 1,
            }],
        }], { session })
        applyCanonicalSimpleStockProjection({ menuItem, inventoryItem })
        await menuItem.save({ session })
        return { replayed: false, menuItem }
    })

    if (!result.replayed) await invalidateMenuMutation(tenantId)
    const [dto] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [result.menuItem] })
    return { replayed: result.replayed, item: dto }
}

export async function adjustSimpleStockMenuItem({
    businessId,
    menuItemId,
    input,
    actor,
    idempotencyKey,
}) {
    const tenantId = requiredText(businessId, "businessId")
    const itemId = requiredText(menuItemId, "menuItemId")
    const key = requiredText(idempotencyKey, "Idempotency-Key")
    const performedBy = normalizeActor(actor)
    const result = await withCanonicalInventoryTransaction(async (session) => {
        const records = await loadMappedRecords({
            businessId: tenantId,
            menuItemId: itemId,
            session,
            activeOnly: true,
        })
        const movementResult = await adjustInventory({
            businessId: tenantId,
            inventoryItemId: records.inventoryItem.inventoryItemId,
            input,
            actor: performedBy,
            idempotencyKey: key,
            session,
        })
        records.inventoryItem.onHandQuantity = movementResult.item.onHandQuantity
        applyCanonicalSimpleStockProjection(records)
        await records.menuItem.save({ session })
        return { ...movementResult, menuItem: records.menuItem }
    })
    await invalidateMenuMutation(tenantId)
    const [item] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [result.menuItem] })
    return { ...result, item, menuItem: undefined }
}

async function projectActiveMappingsForInventoryItem({ businessId, inventoryItemId, session }) {
    const [inventoryItem, mappings] = await Promise.all([
        InventoryItem.findOne({ businessId, inventoryItemId }, null, { session }),
        MenuInventoryRecipe.find({
            businessId,
            mode: MENU_INVENTORY_MODES.SIMPLE,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
            "components.inventoryItemId": inventoryItemId,
        }, null, { session }),
    ])
    if (!inventoryItem) {
        throw new SimpleStockMenuError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND", 404)
    }
    for (const mapping of mappings) {
        const menuItem = await MenuItem.findOne({
            _id: mapping.menuItemId,
            businessId,
            archivedAt: null,
        }, null, { session })
        if (!menuItem) {
            throw new SimpleStockMenuError(
                "Active Simple Stock mapping has no menu item",
                "SIMPLE_STOCK_LINKAGE_BROKEN",
                409,
            )
        }
        applyCanonicalSimpleStockProjection({ menuItem, inventoryItem })
        await menuItem.save({ session })
    }
    return mappings.length
}

export async function executeInventoryMovementWithSimpleStockProjection({
    businessId,
    inventoryItemId,
    input,
    actor,
    idempotencyKey,
    command,
}) {
    const tenantId = requiredText(businessId, "businessId")
    const itemId = requiredText(inventoryItemId, "inventoryItemId", 100)
    if (typeof command !== "function") {
        throw new SimpleStockMenuError("Inventory movement command is required", "INVALID_INVENTORY_COMMAND")
    }
    const result = await withCanonicalInventoryTransaction(async (session) => {
        const movementResult = await command({
            businessId: tenantId,
            inventoryItemId: itemId,
            input,
            actor,
            idempotencyKey,
            session,
        })
        const projectedMenuItems = await projectActiveMappingsForInventoryItem({
            businessId: tenantId,
            inventoryItemId: itemId,
            session,
        })
        return { movementResult, projectedMenuItems }
    })
    if (result.projectedMenuItems > 0) await invalidateMenuMutation(tenantId)
    return result.movementResult
}

export async function executeInventoryMetadataUpdateWithSimpleStockProjection({
    businessId,
    inventoryItemId,
    input,
    command,
}) {
    const tenantId = requiredText(businessId, "businessId")
    const itemId = requiredText(inventoryItemId, "inventoryItemId", 100)
    if (typeof command !== "function") {
        throw new SimpleStockMenuError("Inventory update command is required", "INVALID_INVENTORY_COMMAND")
    }
    const result = await withCanonicalInventoryTransaction(async (session) => {
        const item = await command({
            businessId: tenantId,
            inventoryItemId: itemId,
            input,
            session,
        })
        const projectedMenuItems = await projectActiveMappingsForInventoryItem({
            businessId: tenantId,
            inventoryItemId: itemId,
            session,
        })
        return { item, projectedMenuItems }
    })
    if (result.projectedMenuItems > 0) await invalidateMenuMutation(tenantId)
    return result.item
}

export async function setMappedMenuManualAvailability({ businessId, menuItemId, isAvailable }) {
    const tenantId = requiredText(businessId, "businessId")
    if (typeof isAvailable !== "boolean") {
        throw new SimpleStockMenuError("isAvailable must be boolean", "INVALID_MENU_INVENTORY_INPUT")
    }
    const menuItem = await withCanonicalInventoryTransaction(async (session) => {
        const mapping = await MenuInventoryRecipe.findOne({
            businessId: tenantId,
            menuItemId,
            status: { $ne: MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED },
        }, null, { session })
        const currentMenuItem = await MenuItem.findOne({
            _id: menuItemId,
            businessId: tenantId,
            archivedAt: null,
        }, null, { session })
        if (!mapping || !currentMenuItem) {
            throw new SimpleStockMenuError(
                "Menu inventory mapping not found",
                "MENU_INVENTORY_MAPPING_NOT_FOUND",
                404,
            )
        }
        currentMenuItem.manualIsAvailable = isAvailable
        if (
            mapping.mode === MENU_INVENTORY_MODES.SIMPLE &&
            mapping.status === MENU_INVENTORY_MAPPING_STATUSES.ACTIVE
        ) {
            const inventoryItem = await InventoryItem.findOne({
                businessId: tenantId,
                inventoryItemId: mapping.components[0].inventoryItemId,
            }, null, { session })
            if (!inventoryItem) {
                throw new SimpleStockMenuError(
                    "Simple Stock linkage is incomplete",
                    "SIMPLE_STOCK_LINKAGE_BROKEN",
                    409,
                )
            }
            applyCanonicalSimpleStockProjection({
                menuItem: currentMenuItem,
                inventoryItem,
            })
        } else {
            // Ingredient availability is not enforced in Phase 3; manual owner
            // intent remains the effective public availability boundary.
            currentMenuItem.isAvailable = isAvailable
        }
        await currentMenuItem.save({ session })
        return currentMenuItem
    })
    await invalidateMenuMutation(tenantId)
    const [item] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [menuItem] })
    return item
}

// Backward-compatible export for the Phase 2B controller boundary.
export const setSimpleStockManualAvailability = setMappedMenuManualAvailability

export async function setSimpleStockEnabled({ businessId, menuItemId, enabled, actor }) {
    const tenantId = requiredText(businessId, "businessId")
    if (typeof enabled !== "boolean") {
        throw new SimpleStockMenuError("enabled must be boolean", "INVALID_SIMPLE_STOCK_INPUT")
    }
    const performedBy = normalizeActor(actor)
    const result = await withCanonicalInventoryTransaction(async (session) => {
        const records = await loadMappedRecords({ businessId: tenantId, menuItemId, session })
        if (!enabled) {
            if (records.mapping.status === MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED) {
                throw new SimpleStockMenuError("Archived mapping cannot be disabled", "MAPPING_ARCHIVED", 409)
            }
            records.mapping.status = MENU_INVENTORY_MAPPING_STATUSES.DISABLED
            records.mapping.disabledReason = "owner_disabled"
            records.mapping.disabledAt = new Date()
            records.menuItem.trackStock = false
            records.menuItem.isAvailable = resolveManualMenuAvailability(records.menuItem)
        } else {
            if (records.mapping.disabledReason === "legacy_rollback") {
                const legacyQuantity = nonNegativeInteger(records.menuItem.stockQuantity, "stockQuantity")
                const delta = legacyQuantity - records.inventoryItem.onHandQuantity
                if (delta !== 0) {
                    await adjustInventory({
                        businessId: tenantId,
                        inventoryItemId: records.inventoryItem.inventoryItemId,
                        input: {
                            quantity: Math.abs(delta),
                            unit: records.inventoryItem.trackingUnit,
                            direction: delta > 0 ? "increase" : "decrease",
                            reason: "data_correction",
                            reference: `menu-item:${records.menuItem._id}`,
                            note: "Re-enable Simple Stock after controlled legacy rollback",
                        },
                        actor: performedBy,
                        idempotencyKey: `simple-stock-reenable:${records.mapping._id}:${records.mapping.version}`,
                        session,
                    })
                    records.inventoryItem.onHandQuantity = legacyQuantity
                }
                records.inventoryItem.lowStockThreshold = nonNegativeInteger(
                    records.menuItem.lowStockThreshold ?? 0,
                    "lowStockThreshold",
                )
                await records.inventoryItem.save({ session })
            }
            records.mapping.status = MENU_INVENTORY_MAPPING_STATUSES.ACTIVE
            records.mapping.disabledReason = null
            records.mapping.disabledAt = null
            records.mapping.version += 1
            applyCanonicalSimpleStockProjection(records)
        }
        await records.mapping.save({ session })
        await records.menuItem.save({ session })
        return records.menuItem
    })
    await invalidateMenuMutation(tenantId)
    const [item] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [result] })
    return item
}

export async function updateSimpleStockThreshold({ businessId, menuItemId, lowStockThreshold }) {
    const tenantId = requiredText(businessId, "businessId")
    const threshold = nonNegativeInteger(lowStockThreshold, "lowStockThreshold")
    const menuItem = await withCanonicalInventoryTransaction(async (session) => {
        const records = await loadMappedRecords({
            businessId: tenantId,
            menuItemId,
            session,
            activeOnly: true,
        })
        records.inventoryItem.lowStockThreshold = threshold
        await records.inventoryItem.save({ session })
        applyCanonicalSimpleStockProjection(records)
        await records.menuItem.save({ session })
        return records.menuItem
    })
    await invalidateMenuMutation(tenantId)
    const [item] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [menuItem] })
    return item
}

function projectionDrift({ menuItem, inventoryItem }) {
    const available = inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
    const manual = resolveManualMenuAvailability(menuItem)
    const expectedAvailable = manual && inventoryItem.isActive !== false && available > 0
    const fields = []
    if (menuItem.trackStock !== true) fields.push("trackStock")
    if (menuItem.stockQuantity !== available) fields.push("stockQuantity")
    if (menuItem.lowStockThreshold !== inventoryItem.lowStockThreshold) fields.push("lowStockThreshold")
    if (menuItem.isAvailable !== expectedAvailable) fields.push("isAvailable")
    if (typeof menuItem.manualIsAvailable !== "boolean") fields.push("manualIsAvailable")
    return { fields, availableQuantity: available, expectedIsAvailable: expectedAvailable }
}

export async function readSimpleStockDrift({ businessId }) {
    const tenantId = requiredText(businessId, "businessId")
    const mappings = await MenuInventoryRecipe.find({
        businessId: tenantId,
        mode: MENU_INVENTORY_MODES.SIMPLE,
        status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
    }).lean()
    const results = []
    for (const mapping of mappings) {
        const [menuItem, inventoryItem] = await Promise.all([
            MenuItem.findOne({ _id: mapping.menuItemId, businessId: tenantId }).lean(),
            InventoryItem.findOne({
                businessId: tenantId,
                inventoryItemId: mapping.components?.[0]?.inventoryItemId,
            }).lean(),
        ])
        if (!menuItem || !inventoryItem) {
            results.push({
                menuItemId: String(mapping.menuItemId),
                inventoryItemId: mapping.components?.[0]?.inventoryItemId || null,
                drifted: true,
                fields: [!menuItem ? "menuItemMissing" : "inventoryItemMissing"],
            })
            continue
        }
        const drift = projectionDrift({ menuItem, inventoryItem })
        results.push({
            menuItemId: String(menuItem._id),
            inventoryItemId: inventoryItem.inventoryItemId,
            drifted: drift.fields.length > 0,
            ...drift,
        })
    }
    return {
        businessId: tenantId,
        checked: results.length,
        drifted: results.filter((entry) => entry.drifted).length,
        items: results,
    }
}

export async function reconcileSimpleStockProjection({ businessId, menuItemId = null }) {
    const tenantId = requiredText(businessId, "businessId")
    const changed = await withCanonicalInventoryTransaction(async (session) => {
        const query = {
            businessId: tenantId,
            mode: MENU_INVENTORY_MODES.SIMPLE,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        }
        if (menuItemId) query.menuItemId = menuItemId
        const mappings = await MenuInventoryRecipe.find(query, null, { session })
        let count = 0
        for (const mapping of mappings) {
            const [menuItem, inventoryItem] = await Promise.all([
                MenuItem.findOne({ _id: mapping.menuItemId, businessId: tenantId }, null, { session }),
                InventoryItem.findOne({
                    businessId: tenantId,
                    inventoryItemId: mapping.components[0].inventoryItemId,
                }, null, { session }),
            ])
            if (!menuItem || !inventoryItem) {
                throw new SimpleStockMenuError("Cannot reconcile broken mapping", "SIMPLE_STOCK_LINKAGE_BROKEN", 409)
            }
            if (projectionDrift({ menuItem, inventoryItem }).fields.length > 0) {
                applyCanonicalSimpleStockProjection({ menuItem, inventoryItem })
                await menuItem.save({ session })
                count += 1
            }
        }
        return count
    })
    if (changed > 0) await invalidateMenuMutation(tenantId)
    return { businessId: tenantId, reconciled: changed }
}

export async function rollbackSimpleStockToLegacy({ businessId, menuItemId }) {
    const tenantId = requiredText(businessId, "businessId")
    const menuItem = await withCanonicalInventoryTransaction(async (session) => {
        const records = await loadMappedRecords({
            businessId: tenantId,
            menuItemId,
            session,
            activeOnly: true,
        })
        const drift = projectionDrift(records)
        if (drift.fields.length > 0) {
            throw new SimpleStockMenuError(
                "Simple Stock projection must be reconciled before rollback",
                "SIMPLE_STOCK_DRIFT_BLOCKS_ROLLBACK",
                409,
            )
        }
        const cancellationRisk = await Order.exists({
            businessId: tenantId,
            status: "placed",
            inventoryDeducted: true,
            inventoryRestored: { $ne: true },
            inventorySemanticsVersion: {
                $in: [
                    ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1,
                    ORDER_INVENTORY_SEMANTICS.MIXED_BRIDGE_V1,
                ],
            },
            inventoryDeductionLines: {
                $elemMatch: { inventoryItemId: records.inventoryItem.inventoryItemId },
            },
        }).session(session)
        if (cancellationRisk) {
            throw new SimpleStockMenuError(
                "Open cancellable orders block Simple Stock rollback",
                "OPEN_CANONICAL_CANCELLATION_RISK",
                409,
            )
        }
        records.mapping.status = MENU_INVENTORY_MAPPING_STATUSES.DISABLED
        records.mapping.disabledReason = "legacy_rollback"
        records.mapping.disabledAt = new Date()
        records.mapping.version += 1
        records.menuItem.trackStock = true
        records.menuItem.stockQuantity = records.inventoryItem.onHandQuantity - records.inventoryItem.reservedQuantity
        records.menuItem.lowStockThreshold = records.inventoryItem.lowStockThreshold
        records.menuItem.isAvailable = resolveManualMenuAvailability(records.menuItem) && records.menuItem.stockQuantity > 0
        await records.mapping.save({ session })
        await records.menuItem.save({ session })
        return records.menuItem
    })
    await invalidateMenuMutation(tenantId)
    const [item] = await enrichMenuItemsWithInventory({ businessId: tenantId, menuItems: [menuItem] })
    return item
}

export async function archiveMappedMenuItem({ businessId, menuItemId }) {
    const tenantId = requiredText(businessId, "businessId")
    await withCanonicalInventoryTransaction(async (session) => {
        const [mapping, menuItem] = await Promise.all([
            MenuInventoryRecipe.findOne({
                businessId: tenantId,
                menuItemId,
            }, null, { session }),
            MenuItem.findOne({
                _id: menuItemId,
                businessId: tenantId,
                archivedAt: null,
            }, null, { session }),
        ])
        if (!mapping || !menuItem) {
            throw new SimpleStockMenuError(
                "Mapped menu item not found",
                "MENU_INVENTORY_MAPPING_NOT_FOUND",
                404,
            )
        }
        const archivedAt = new Date()
        mapping.status = MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED
        mapping.disabledReason = "archived"
        mapping.disabledAt = archivedAt
        mapping.archivedAt = archivedAt
        menuItem.archivedAt = archivedAt
        menuItem.manualIsAvailable = false
        menuItem.isAvailable = false
        await mapping.save({ session })
        await menuItem.save({ session })
    })
    await invalidateMenuMutation(tenantId)
    return { archived: true, menuItemId: String(menuItemId) }
}

export async function hasAnyMenuInventoryMapping({ businessId, menuItemId }) {
    return Boolean(await MenuInventoryRecipe.exists({ businessId, menuItemId }))
}
