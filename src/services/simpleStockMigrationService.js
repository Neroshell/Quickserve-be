import crypto from "node:crypto"

import {
    LEGACY_MENU_STOCK_MIGRATION_SOURCE,
    LEGACY_MENU_STOCK_MIGRATION_VERSION,
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../constants/menuInventory.js"
import { ORDER_INVENTORY_SEMANTICS } from "../constants/orderInventory.js"
import MenuInventoryRecipe from "../models/MenuInventoryRecipe.js"
import InventoryItem from "../models/InventoryItem.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import {
    adjustInventory,
    createInventoryDuplicateError,
    createInventoryItem,
    enrichInventoryDuplicateError,
    normalizeInventoryItemCategory,
    normalizeInventoryItemName,
    withCanonicalInventoryTransaction,
} from "./canonicalInventoryService.js"
import { invalidateMenuItems } from "./cacheInvalidationService.js"

export const SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS = Object.freeze({
    ELIGIBLE: "eligible",
    BLOCKED: "blocked",
    NOT_APPLICABLE: "not_applicable",
    ALREADY_MAPPED: "already_mapped",
})

export class SimpleStockMigrationError extends Error {
    constructor(message, code = "SIMPLE_STOCK_MIGRATION_ERROR") {
        super(message)
        this.name = "SimpleStockMigrationError"
        this.code = code
        this.statusCode = 400
    }
}

function requiredIdentity(value, field) {
    const normalized = String(value ?? "").trim()
    if (!normalized) throw new SimpleStockMigrationError(`${field} is required`)
    return normalized
}

function stableDigest({ businessId, menuItemId }) {
    const tenantId = requiredIdentity(businessId, "businessId")
    const itemId = requiredIdentity(menuItemId, "menuItemId")
    return crypto.createHash("sha256").update(`${tenantId}:${itemId}`).digest("hex")
}

export function buildDeterministicSimpleStockMigrationIdentities({ businessId, menuItemId }) {
    const digest = stableDigest({ businessId, menuItemId })
    return Object.freeze({
        inventoryItemId: `inv_mig_${digest.slice(0, 24)}`,
        menuInventoryRecipeId: `mir_mig_${digest.slice(0, 24)}`,
        openingMovementId: `imv_mig_${digest.slice(0, 24)}`,
        openingIdempotencyKey: `simple-stock-migration:v1:${digest}:opening`,
    })
}

function invalidNonNegativeSafeInteger(value) {
    return !Number.isSafeInteger(value) || value < 0
}

export function classifyLegacyMenuItemForSimpleStock(menuItemValue, {
    alreadyMapped = false,
    hasOpenLegacyCancellationRisk = false,
} = {}) {
    const menuItem = typeof menuItemValue?.toObject === "function"
        ? menuItemValue.toObject({ depopulate: true })
        : menuItemValue || {}
    const businessId = requiredIdentity(menuItem.businessId, "businessId")
    const menuItemId = requiredIdentity(menuItem._id || menuItem.id, "menuItemId")
    const warnings = []
    const blockers = []

    if (alreadyMapped) {
        return Object.freeze({
            classification: SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.ALREADY_MAPPED,
            businessId,
            menuItemId,
            name: menuItem.name || "",
            blockers,
            warnings,
            candidate: null,
        })
    }

    if (menuItem.trackStock !== true) {
        if (menuItem.stockQuantity !== null && menuItem.stockQuantity !== undefined) {
            warnings.push("DORMANT_UNTRACKED_STOCK_QUANTITY")
        }
        return Object.freeze({
            classification: SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.NOT_APPLICABLE,
            businessId,
            menuItemId,
            name: menuItem.name || "",
            blockers,
            warnings,
            candidate: null,
        })
    }

    if (menuItem.stockQuantity === null || menuItem.stockQuantity === undefined) {
        blockers.push("MISSING_STOCK_QUANTITY")
    } else if (invalidNonNegativeSafeInteger(menuItem.stockQuantity)) {
        blockers.push("INVALID_STOCK_QUANTITY")
    }

    let lowStockThreshold = menuItem.lowStockThreshold
    if (lowStockThreshold === null || lowStockThreshold === undefined) {
        lowStockThreshold = 5
        warnings.push("DEFAULTED_LOW_STOCK_THRESHOLD")
    } else if (invalidNonNegativeSafeInteger(lowStockThreshold)) {
        blockers.push("INVALID_LOW_STOCK_THRESHOLD")
    }

    if (hasOpenLegacyCancellationRisk) {
        blockers.push("OPEN_LEGACY_CANCELLATION_RISK")
    }

    const legacyIsAvailable = menuItem.isAvailable !== false
    const manualIsAvailable = typeof menuItem.manualIsAvailable === "boolean"
        ? menuItem.manualIsAvailable
        : legacyIsAvailable
    const requiresOwnerAvailabilityReview = (
        menuItem.stockQuantity === 0 &&
        legacyIsAvailable === false
    )
    if (requiresOwnerAvailabilityReview) {
        warnings.push("ZERO_STOCK_UNAVAILABLE_REQUIRES_OWNER_REVIEW")
    }

    if (blockers.length > 0) {
        return Object.freeze({
            classification: SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.BLOCKED,
            businessId,
            menuItemId,
            name: menuItem.name || "",
            blockers,
            warnings,
            candidate: null,
        })
    }

    const identities = buildDeterministicSimpleStockMigrationIdentities({
        businessId,
        menuItemId,
    })
    return Object.freeze({
        classification: SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.ELIGIBLE,
        businessId,
        menuItemId,
        name: menuItem.name || "",
        blockers,
        warnings,
        candidate: Object.freeze({
            trackingUnit: "piece",
            openingQuantity: menuItem.stockQuantity,
            reservedQuantity: 0,
            lowStockThreshold,
            manualIsAvailable,
            requiresOwnerAvailabilityReview,
            identities,
            mapping: Object.freeze({
                mode: "simple",
                status: "disabled",
                component: Object.freeze({
                    inventoryItemId: identities.inventoryItemId,
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }),
            }),
            migration: Object.freeze({
                source: LEGACY_MENU_STOCK_MIGRATION_SOURCE,
                version: LEGACY_MENU_STOCK_MIGRATION_VERSION,
                legacySnapshot: Object.freeze({
                    trackStock: true,
                    stockQuantity: menuItem.stockQuantity,
                    lowStockThreshold: menuItem.lowStockThreshold ?? null,
                    isAvailable: legacyIsAvailable,
                    menuUpdatedAt: menuItem.updatedAt ?? null,
                }),
            }),
        }),
    })
}

export function buildSimpleStockMigrationDryRun({
    businessId,
    menuItems,
    existingMappedMenuItemIds = [],
    openLegacyCancellationMenuItemIds = [],
    generatedAt = new Date(),
}) {
    const tenantId = requiredIdentity(businessId, "businessId")
    if (!Array.isArray(menuItems)) {
        throw new SimpleStockMigrationError("menuItems must be an array")
    }
    const mapped = new Set(existingMappedMenuItemIds.map(String))
    const cancellationRisks = new Set(openLegacyCancellationMenuItemIds.map(String))
    const items = menuItems.map((menuItem) => {
        if (String(menuItem.businessId) !== tenantId) {
            throw new SimpleStockMigrationError(
                "Dry-run input contains a MenuItem from another business",
                "CROSS_TENANT_MIGRATION_INPUT",
            )
        }
        const menuItemId = String(menuItem._id || menuItem.id)
        return classifyLegacyMenuItemForSimpleStock(menuItem, {
            alreadyMapped: mapped.has(menuItemId),
            hasOpenLegacyCancellationRisk: cancellationRisks.has(menuItemId),
        })
    })
    const summary = Object.values(SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS).reduce(
        (counts, classification) => ({
            ...counts,
            [classification]: items.filter((item) => item.classification === classification).length,
        }),
        { total: items.length },
    )
    return Object.freeze({
        dryRun: true,
        wouldWrite: false,
        businessId: tenantId,
        generatedAt: new Date(generatedAt).toISOString(),
        summary,
        items,
    })
}

export async function readSimpleStockMigrationDryRun({ businessId }, {
    MenuItemModel = MenuItem,
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    OrderModel = Order,
    now = () => new Date(),
} = {}) {
    const tenantId = requiredIdentity(businessId, "businessId")
    const [menuItems, mappings, cancellableOrders] = await Promise.all([
        MenuItemModel.find({ businessId: tenantId })
            .select("_id businessId name trackStock stockQuantity lowStockThreshold isAvailable manualIsAvailable updatedAt")
            .sort({ _id: 1 })
            .lean(),
        MenuInventoryRecipeModel.find({ businessId: tenantId })
            .select("menuItemId")
            .lean(),
        OrderModel.find({
            businessId: tenantId,
            paymentChannel: "offline",
            status: "placed",
            inventoryDeducted: true,
            inventoryRestored: { $ne: true },
            $or: [
                { inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1 },
                { inventorySemanticsVersion: { $exists: false } },
                { inventorySemanticsVersion: null },
            ],
        })
            .select("items.menuItemId items.itemName")
            .lean(),
    ])
    const menuItemIdsByName = new Map()
    for (const menuItem of menuItems) {
        if (!menuItem.name) continue
        const ids = menuItemIdsByName.get(menuItem.name) || []
        ids.push(menuItem._id)
        menuItemIdsByName.set(menuItem.name, ids)
    }
    const openLegacyCancellationMenuItemIds = cancellableOrders.flatMap((order) => (
        order.items || []
    )).flatMap((item) => (
        item.menuItemId
            ? [item.menuItemId]
            : menuItemIdsByName.get(item.itemName) || []
    ))
    return buildSimpleStockMigrationDryRun({
        businessId: tenantId,
        menuItems,
        existingMappedMenuItemIds: mappings.map((mapping) => mapping.menuItemId),
        openLegacyCancellationMenuItemIds,
        generatedAt: now(),
    })
}

function normalizeMigrationActor(actor) {
    if (!actor || typeof actor !== "object") {
        throw new SimpleStockMigrationError(
            "Authenticated actor is required",
            "MIGRATION_ACTOR_REQUIRED",
        )
    }
    return {
        staffId: requiredIdentity(actor.staffId, "actor.staffId"),
        role: requiredIdentity(actor.role, "actor.role"),
        name: requiredIdentity(actor.name, "actor.name"),
    }
}

async function hasOpenLegacyCancellationRisk({ businessId, menuItem, session }) {
    const clauses = [{ "items.menuItemId": menuItem._id }]
    if (menuItem.name) clauses.push({ "items.itemName": menuItem.name })
    return Boolean(await Order.exists({
        businessId,
        paymentChannel: "offline",
        status: "placed",
        inventoryDeducted: true,
        inventoryRestored: { $ne: true },
        $and: [
            { $or: clauses },
            { $or: [
                { inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1 },
                { inventorySemanticsVersion: { $exists: false } },
                { inventorySemanticsVersion: null },
            ] },
        ],
    }).session(session))
}

function isExactMigrationReplay(mapping, identities, expectedInventoryItemId) {
    return mapping?.menuInventoryRecipeId === identities.menuInventoryRecipeId &&
        mapping?.migration?.source === LEGACY_MENU_STOCK_MIGRATION_SOURCE &&
        mapping?.migration?.version === LEGACY_MENU_STOCK_MIGRATION_VERSION &&
        mapping?.components?.length === 1 &&
        mapping.components[0].inventoryItemId === expectedInventoryItemId
}

/**
 * Transaction-only Phase 2B migration executor. Eligibility is recomputed from
 * fresh data inside the same transaction that writes the opening ledger,
 * mapping, compatibility projection, and canonical authority cutover.
 */
export async function migrateLegacyMenuItemToSimpleStock({
    businessId,
    menuItemId,
    actor,
    inventoryItemId = null,
    reactivateInventoryItem = false,
    allowCategoryVariant = false,
}, {
    startSession,
    now = () => new Date(),
} = {}) {
    const tenantId = requiredIdentity(businessId, "businessId")
    const itemId = requiredIdentity(menuItemId, "menuItemId")
    const reuseInventoryItemId = inventoryItemId === null || inventoryItemId === undefined
        ? null
        : requiredIdentity(inventoryItemId, "inventoryItemId")
    if (typeof reactivateInventoryItem !== "boolean" || typeof allowCategoryVariant !== "boolean") {
        throw new SimpleStockMigrationError(
            "reactivateInventoryItem and allowCategoryVariant must be boolean",
            "INVALID_SIMPLE_STOCK_MIGRATION_INPUT",
        )
    }
    const performedBy = normalizeMigrationActor(actor)
    const identities = buildDeterministicSimpleStockMigrationIdentities({
        businessId: tenantId,
        menuItemId: itemId,
    })

    let result
    try {
        result = await withCanonicalInventoryTransaction(async (session) => {
        const menuItem = await MenuItem.findOne({ _id: itemId, businessId: tenantId }, null, { session })
        if (!menuItem) {
            const error = new SimpleStockMigrationError("Menu item not found", "MENU_ITEM_NOT_FOUND")
            error.statusCode = 404
            throw error
        }

        const existingMapping = await MenuInventoryRecipe.findOne({
            businessId: tenantId,
            menuItemId: menuItem._id,
        }, null, { session })
        if (existingMapping) {
            if (isExactMigrationReplay(
                existingMapping,
                identities,
                reuseInventoryItemId || identities.inventoryItemId,
            )) {
                return {
                    replayed: true,
                    menuItemId: itemId,
                    inventoryItemId: existingMapping.components[0].inventoryItemId,
                    menuInventoryRecipeId: identities.menuInventoryRecipeId,
                }
            }
            const error = new SimpleStockMigrationError(
                "Menu item already has a different inventory mapping",
                "MENU_ITEM_ALREADY_MAPPED",
            )
            error.statusCode = 409
            throw error
        }

        const cancellationRisk = await hasOpenLegacyCancellationRisk({
            businessId: tenantId,
            menuItem,
            session,
        })
        const classification = classifyLegacyMenuItemForSimpleStock(menuItem, {
            hasOpenLegacyCancellationRisk: cancellationRisk,
        })
        if (classification.classification !== SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.ELIGIBLE) {
            const error = new SimpleStockMigrationError(
                "Menu item is not eligible for Simple Stock migration",
                "SIMPLE_STOCK_MIGRATION_BLOCKED",
            )
            error.statusCode = 409
            error.classification = classification
            throw error
        }

        const candidate = classification.candidate
        let inventoryItem
        let createdInventoryItem = false
        if (reuseInventoryItemId) {
            inventoryItem = await InventoryItem.findOne({
                businessId: tenantId,
                inventoryItemId: reuseInventoryItemId,
                deletedAt: null,
            }, null, { session })
            if (!inventoryItem) {
                const error = new SimpleStockMigrationError(
                    "Selected inventory item was not found",
                    "SIMPLE_STOCK_REUSE_ITEM_NOT_FOUND",
                )
                error.statusCode = 404
                throw error
            }
            if (
                normalizeInventoryItemName(inventoryItem.name) !== normalizeInventoryItemName(menuItem.name) ||
                normalizeInventoryItemCategory(inventoryItem.category) !== normalizeInventoryItemCategory(menuItem.category) ||
                inventoryItem.trackingUnit !== candidate.trackingUnit
            ) {
                const error = new SimpleStockMigrationError(
                    "Selected inventory item does not match the menu item name, category, and stock unit",
                    "SIMPLE_STOCK_REUSE_MISMATCH",
                )
                error.statusCode = 409
                throw error
            }
            if (inventoryItem.isActive === false) {
                if (!reactivateInventoryItem) {
                    throw createInventoryDuplicateError(inventoryItem, "strong")
                }
                inventoryItem.isActive = true
                await inventoryItem.save({ session })
            }
        } else {
            await createInventoryItem({
                businessId: tenantId,
                input: {
                    name: menuItem.name,
                    category: menuItem.category || null,
                    trackingUnit: candidate.trackingUnit,
                    lowStockThreshold: candidate.lowStockThreshold,
                },
                allowCategoryVariant,
                session,
            }, { generateId: () => identities.inventoryItemId })
            inventoryItem = await InventoryItem.findOne({
                businessId: tenantId,
                inventoryItemId: identities.inventoryItemId,
            }, null, { session })
            createdInventoryItem = true
        }

        if (createdInventoryItem && candidate.openingQuantity > 0) {
            await adjustInventory({
                businessId: tenantId,
                inventoryItemId: inventoryItem.inventoryItemId,
                input: {
                    quantity: candidate.openingQuantity,
                    unit: candidate.trackingUnit,
                    direction: "increase",
                    reason: "opening_balance_correction",
                    reference: `menu-item:${itemId}`,
                    note: "Simple Stock migration opening balance",
                },
                actor: performedBy,
                idempotencyKey: identities.openingIdempotencyKey,
                session,
            }, {
                generateMovementId: () => identities.openingMovementId,
            })
            inventoryItem.onHandQuantity = candidate.openingQuantity
        }

        const migratedAt = now()
        await MenuInventoryRecipe.create([{
            menuInventoryRecipeId: identities.menuInventoryRecipeId,
            businessId: tenantId,
            menuItemId: menuItem._id,
            mode: MENU_INVENTORY_MODES.SIMPLE,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
            version: 1,
            components: [{
                inventoryItemId: inventoryItem.inventoryItemId,
                quantity: 1,
                unit: candidate.trackingUnit,
                canonicalQuantity: 1,
            }],
            migration: {
                ...candidate.migration,
                migratedAt,
                requiresOwnerAvailabilityReview: candidate.requiresOwnerAvailabilityReview,
            },
        }], { session })

        menuItem.manualIsAvailable = candidate.manualIsAvailable
        menuItem.trackStock = true
        menuItem.stockQuantity = inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
        menuItem.lowStockThreshold = inventoryItem.lowStockThreshold
        menuItem.isAvailable = candidate.manualIsAvailable &&
            inventoryItem.isActive !== false &&
            menuItem.stockQuantity > 0
        await menuItem.save({ session })

        return {
            replayed: false,
            menuItemId: itemId,
            inventoryItemId: inventoryItem.inventoryItemId,
            menuInventoryRecipeId: identities.menuInventoryRecipeId,
            classification,
        }
        }, startSession ? { startSession } : undefined)
    } catch (error) {
        if (!error?.duplicateIdentity) throw error
        throw await enrichInventoryDuplicateError(error, error.duplicateIdentity)
    }

    if (!result.replayed) await invalidateMenuItems(tenantId)
    return result
}
