import mongoose from "mongoose"

import { MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    MAX_INGREDIENT_RECIPE_COMPONENTS,
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../constants/menuInventory.js"
import InventoryItem from "../models/InventoryItem.js"
import MenuInventoryRecipe, {
    generateMenuInventoryRecipeId,
} from "../models/MenuInventoryRecipe.js"
import MenuItem from "../models/menuItem.js"
import { withCanonicalInventoryTransaction } from "./canonicalInventoryService.js"
import { invalidateMenuMutation } from "./cacheInvalidationService.js"
import { resolveManualMenuAvailability } from "./menuInventoryAvailabilityService.js"
import { normalizeInventoryQuantity } from "./inventoryUomService.js"

const STANDARD_LIFECYCLE_TRANSITIONS = Object.freeze({
    [MENU_INVENTORY_MAPPING_STATUSES.ACTIVE]: new Set([
        MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
        MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED,
    ]),
    [MENU_INVENTORY_MAPPING_STATUSES.DISABLED]: new Set([
        MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED,
    ]),
    [MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED]: new Set(),
    [MENU_INVENTORY_MAPPING_STATUSES.ORPHANED]: new Set(),
})

export const RECIPE_COST_STATUSES = Object.freeze({
    COMPLETE: "complete",
    MISSING_COST: "missing_cost",
    MIXED_CURRENCY: "mixed_currency",
})

export class MenuInventoryRecipeError extends Error {
    constructor(message, { code = "MENU_INVENTORY_MAPPING_ERROR", statusCode = 400 } = {}) {
        super(message)
        this.name = "MenuInventoryRecipeError"
        this.code = code
        this.statusCode = statusCode
    }
}

function mappingError(message, code, statusCode = 400) {
    return new MenuInventoryRecipeError(message, { code, statusCode })
}

function requiredText(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw mappingError(`${field} is required`, "INVALID_MENU_INVENTORY_MAPPING")
    }
    const normalized = value.trim()
    if (normalized.length > maxLength) {
        throw mappingError(`${field} is too long`, "INVALID_MENU_INVENTORY_MAPPING")
    }
    return normalized
}

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : { ...value }
}

function sessionOptions(session) {
    return session ? { session } : undefined
}

export function toMenuInventoryRecipeDTO(value) {
    const mapping = plain(value)
    if (!mapping) return null
    return {
        menuInventoryRecipeId: mapping.menuInventoryRecipeId,
        menuItemId: String(mapping.menuItemId),
        mode: mapping.mode,
        status: mapping.status,
        version: mapping.version,
        components: (mapping.components || []).map((component) => ({
            inventoryItemId: component.inventoryItemId,
            quantity: component.quantity,
            unit: component.unit,
            canonicalQuantity: component.canonicalQuantity,
        })),
        migration: mapping.migration ? plain(mapping.migration) : null,
        disabledReason: mapping.disabledReason ?? null,
        disabledAt: mapping.disabledAt ?? null,
        archivedAt: mapping.archivedAt ?? null,
        createdAt: mapping.createdAt ?? null,
        updatedAt: mapping.updatedAt ?? null,
    }
}

function normalizeMenuItemId(value) {
    if (!mongoose.isValidObjectId(value)) {
        throw mappingError("menuItemId is invalid", "INVALID_MENU_ITEM_ID")
    }
    return new mongoose.Types.ObjectId(value)
}

function normalizeInitialStatus(value) {
    const status = value ?? MENU_INVENTORY_MAPPING_STATUSES.DISABLED
    if (![
        MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
        MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
    ].includes(status)) {
        throw mappingError(
            "A new mapping must start disabled or active",
            "INVALID_MENU_INVENTORY_MAPPING_STATUS",
        )
    }
    return status
}

function normalizeBoolean(value, field, defaultValue) {
    if (value === undefined) return defaultValue
    if (typeof value !== "boolean") {
        throw mappingError(`${field} must be boolean`, "INVALID_INGREDIENT_RECIPE")
    }
    return value
}

function submittedQuantity(value) {
    const normalized = Number(String(value).trim())
    if (!Number.isFinite(normalized) || normalized <= 0) {
        throw mappingError("Recipe quantity must be greater than zero", "INVALID_INGREDIENT_RECIPE")
    }
    return normalized
}

export async function validateSimpleMenuInventoryRelationship({
    businessId,
    menuItemId,
    components,
    requireActiveInventoryItem = true,
    session = null,
}, {
    MenuItemModel = MenuItem,
    InventoryItemModel = InventoryItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const normalizedMenuItemId = normalizeMenuItemId(menuItemId)
    if (!Array.isArray(components) || components.length !== 1) {
        throw mappingError(
            "Simple Stock requires exactly one inventory component",
            "INVALID_SIMPLE_STOCK_COMPONENTS",
        )
    }

    const menuItem = await MenuItemModel.findOne(
        { _id: normalizedMenuItemId, businessId: tenantId },
        null,
        sessionOptions(session),
    )
    if (!menuItem) {
        throw mappingError("Menu item not found", "MENU_ITEM_NOT_FOUND", 404)
    }

    const component = components[0] || {}
    const inventoryItemId = requiredText(
        component.inventoryItemId,
        "components[0].inventoryItemId",
        100,
    )
    const inventoryItem = await InventoryItemModel.findOne(
        { businessId: tenantId, inventoryItemId },
        null,
        sessionOptions(session),
    )
    if (!inventoryItem) {
        throw mappingError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND", 404)
    }
    if (requireActiveInventoryItem && inventoryItem.isActive === false) {
        throw mappingError("Inventory item is inactive", "INVENTORY_ITEM_INACTIVE", 409)
    }

    const normalizedQuantity = normalizeInventoryQuantity({
        quantity: component.quantity,
        unit: component.unit,
        trackingUnit: inventoryItem.trackingUnit,
    })
    if (
        normalizedQuantity.canonicalQuantity !== 1 ||
        component.canonicalQuantity !== undefined && component.canonicalQuantity !== 1
    ) {
        throw mappingError(
            "Simple Stock requires one canonical inventory unit per menu sale",
            "INVALID_SIMPLE_STOCK_QUANTITY",
        )
    }

    return {
        menuItem,
        inventoryItems: [inventoryItem],
        components: [{
            inventoryItemId,
            quantity: 1,
            unit: normalizedQuantity.submittedUnit,
            canonicalQuantity: 1,
        }],
    }
}

export async function validateIngredientRecipeRelationship({
    businessId,
    menuItemId,
    components,
    requireActiveInventoryItems = true,
    session = null,
}, {
    MenuItemModel = MenuItem,
    InventoryItemModel = InventoryItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const normalizedMenuItemId = normalizeMenuItemId(menuItemId)
    if (
        !Array.isArray(components) ||
        components.length === 0 ||
        components.length > MAX_INGREDIENT_RECIPE_COMPONENTS
    ) {
        throw mappingError(
            `Ingredient recipes require 1-${MAX_INGREDIENT_RECIPE_COMPONENTS} components`,
            "INVALID_INGREDIENT_RECIPE",
        )
    }

    const requestedComponents = components.map((component, index) => ({
        inventoryItemId: requiredText(
            component?.inventoryItemId,
            `components[${index}].inventoryItemId`,
            100,
        ),
        quantity: component?.quantity,
        unit: requiredText(component?.unit, `components[${index}].unit`, 20),
    }))
    const inventoryItemIds = requestedComponents.map((component) => component.inventoryItemId)
    if (new Set(inventoryItemIds).size !== inventoryItemIds.length) {
        throw mappingError(
            "Ingredient recipes cannot contain duplicate inventory items",
            "DUPLICATE_RECIPE_COMPONENT",
        )
    }

    const [menuItem, inventoryItems] = await Promise.all([
        MenuItemModel.findOne(
            { _id: normalizedMenuItemId, businessId: tenantId, archivedAt: null },
            null,
            sessionOptions(session),
        ),
        InventoryItemModel.find(
            { businessId: tenantId, inventoryItemId: { $in: inventoryItemIds } },
            null,
            sessionOptions(session),
        ),
    ])
    if (!menuItem) {
        throw mappingError("Menu item not found", "MENU_ITEM_NOT_FOUND", 404)
    }

    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))
    const normalizedComponents = requestedComponents.map((component) => {
        const inventoryItem = inventoryById.get(component.inventoryItemId)
        if (!inventoryItem) {
            throw mappingError(
                `Inventory item ${component.inventoryItemId} was not found`,
                "INVENTORY_ITEM_NOT_FOUND",
                404,
            )
        }
        if (requireActiveInventoryItems && inventoryItem.isActive === false) {
            throw mappingError(
                `Inventory item ${component.inventoryItemId} is inactive`,
                "INVENTORY_ITEM_INACTIVE",
                409,
            )
        }
        const normalized = normalizeInventoryQuantity({
            quantity: component.quantity,
            unit: component.unit,
            trackingUnit: inventoryItem.trackingUnit,
        })
        return {
            inventoryItemId: component.inventoryItemId,
            quantity: submittedQuantity(component.quantity),
            unit: normalized.submittedUnit,
            canonicalQuantity: normalized.canonicalQuantity,
        }
    })

    return { menuItem, inventoryItems, components: normalizedComponents }
}

function inventoryMap(inventoryItems) {
    return new Map((inventoryItems || []).map((value) => {
        const item = plain(value)
        return [item.inventoryItemId, item]
    }))
}

export function calculateIngredientRecipeCost({ components, inventoryItems }) {
    const byId = inventoryMap(inventoryItems)
    const missingCostInventoryItemIds = []
    const currencies = new Set()
    let knownTotal = 0n

    for (const component of components || []) {
        const inventoryItem = byId.get(component.inventoryItemId)
        if (
            !inventoryItem ||
            !Number.isSafeInteger(inventoryItem.unitCostMinor) ||
            !inventoryItem.costCurrency
        ) {
            missingCostInventoryItemIds.push(component.inventoryItemId)
            continue
        }
        currencies.add(inventoryItem.costCurrency)
        knownTotal += BigInt(component.canonicalQuantity) * BigInt(inventoryItem.unitCostMinor)
        if (knownTotal > BigInt(MAX_INVENTORY_QUANTITY)) {
            throw mappingError("Recipe cost exceeds the safe integer limit", "RECIPE_COST_OVERFLOW", 409)
        }
    }

    const mixedCurrency = currencies.size > 1
    const complete = missingCostInventoryItemIds.length === 0 && !mixedCurrency
    return Object.freeze({
        status: mixedCurrency
            ? RECIPE_COST_STATUSES.MIXED_CURRENCY
            : missingCostInventoryItemIds.length > 0
                ? RECIPE_COST_STATUSES.MISSING_COST
                : RECIPE_COST_STATUSES.COMPLETE,
        estimatedCostMinor: complete ? Number(knownTotal) : null,
        knownCostMinor: mixedCurrency ? null : Number(knownTotal),
        currency: currencies.size === 1 ? [...currencies][0] : null,
        missingCostInventoryItemIds,
        currencies: [...currencies].sort(),
    })
}

function componentDTO(component, inventoryItem) {
    const item = plain(inventoryItem)
    const hasCost = item && Number.isSafeInteger(item.unitCostMinor) && item.costCurrency
    const componentCost = hasCost
        ? BigInt(component.canonicalQuantity) * BigInt(item.unitCostMinor)
        : null
    return {
        inventoryItemId: component.inventoryItemId,
        inventoryItemName: item?.name ?? null,
        quantity: component.quantity,
        unit: component.unit,
        canonicalQuantity: component.canonicalQuantity,
        trackingUnit: item?.trackingUnit ?? null,
        inventoryItemActive: item?.isActive ?? null,
        unitCostMinor: item?.unitCostMinor ?? null,
        costCurrency: item?.costCurrency ?? null,
        estimatedComponentCostMinor: componentCost === null ? null : Number(componentCost),
    }
}

export function toIngredientRecipeDTO({ mapping: mappingValue, menuItem: menuItemValue, inventoryItems }) {
    const mapping = plain(mappingValue)
    const menuItem = plain(menuItemValue)
    const byId = inventoryMap(inventoryItems)
    const base = toMenuInventoryRecipeDTO(mapping)
    return {
        ...base,
        menuItem: menuItem ? {
            id: String(menuItem._id),
            name: menuItem.name,
            category: menuItem.category,
            type: menuItem.type,
            price: menuItem.price,
            manualIsAvailable: resolveManualMenuAvailability(menuItem),
        } : null,
        components: base.components.map((component) => componentDTO(
            component,
            byId.get(component.inventoryItemId),
        )),
        costing: calculateIngredientRecipeCost({
            components: base.components,
            inventoryItems,
        }),
    }
}

export async function createSimpleMenuInventoryRecipe({
    businessId,
    menuItemId,
    components,
    status,
    migration = null,
    session = null,
}, {
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    generateId = generateMenuInventoryRecipeId,
    ...validationDependencies
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const normalizedMenuItemId = normalizeMenuItemId(menuItemId)
    const normalizedStatus = normalizeInitialStatus(status)

    const existing = await MenuInventoryRecipeModel.findOne(
        { businessId: tenantId, menuItemId: normalizedMenuItemId },
        null,
        sessionOptions(session),
    )
    if (existing) {
        throw mappingError(
            "Menu item already has an inventory mapping",
            "MENU_INVENTORY_MAPPING_EXISTS",
            409,
        )
    }

    const validated = await validateSimpleMenuInventoryRelationship({
        businessId: tenantId,
        menuItemId: normalizedMenuItemId,
        components,
        requireActiveInventoryItem: normalizedStatus === MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        session,
    }, validationDependencies)

    const input = {
        menuInventoryRecipeId: generateId(),
        businessId: tenantId,
        menuItemId: normalizedMenuItemId,
        mode: MENU_INVENTORY_MODES.SIMPLE,
        status: normalizedStatus,
        version: 1,
        components: validated.components,
        migration,
    }
    const mapping = session
        ? (await MenuInventoryRecipeModel.create([input], { session }))[0]
        : await MenuInventoryRecipeModel.create(input)
    return toMenuInventoryRecipeDTO(mapping)
}

function componentsEqual(left, right) {
    if (!Array.isArray(left) || left.length !== right.length) return false
    return left.every((component, index) => (
        component.inventoryItemId === right[index].inventoryItemId &&
        component.quantity === right[index].quantity &&
        component.unit === right[index].unit &&
        component.canonicalQuantity === right[index].canonicalQuantity
    ))
}

async function upsertIngredientRecipeWithinTransaction({
    businessId,
    menuItemId,
    components,
    enabled,
    replaceSimpleStock,
    replaceLegacyStock,
    session,
}, {
    MenuInventoryRecipeModel,
    InventoryItemModel,
    MenuItemModel,
    generateId,
}) {
    const validated = await validateIngredientRecipeRelationship({
        businessId,
        menuItemId,
        components,
        requireActiveInventoryItems: enabled,
        session,
    }, { MenuItemModel, InventoryItemModel })
    const existing = await MenuInventoryRecipeModel.findOne(
        { businessId, menuItemId },
        null,
        { session },
    )
    if (existing?.status === MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED) {
        throw mappingError("Archived inventory mappings cannot be replaced", "MAPPING_ARCHIVED", 409)
    }
    if (existing?.mode === MENU_INVENTORY_MODES.SIMPLE && !replaceSimpleStock) {
        throw mappingError(
            "Replacing Simple Stock requires replaceSimpleStock=true",
            "SIMPLE_STOCK_REPLACEMENT_CONFIRMATION_REQUIRED",
            409,
        )
    }
    if (!existing && validated.menuItem.trackStock === true && !replaceLegacyStock) {
        throw mappingError(
            "Replacing legacy stock requires replaceLegacyStock=true",
            "LEGACY_STOCK_REPLACEMENT_CONFIRMATION_REQUIRED",
            409,
        )
    }
    if (existing?.mode === MENU_INVENTORY_MODES.SIMPLE) {
        const oldInventoryItemIds = existing.components.map((component) => component.inventoryItemId)
        const reservedSource = await InventoryItemModel.findOne({
            businessId,
            inventoryItemId: { $in: oldInventoryItemIds },
            reservedQuantity: { $gt: 0 },
        }, null, { session })
        if (reservedSource) {
            throw mappingError(
                "Simple Stock cannot be replaced while inventory is reserved",
                "SIMPLE_STOCK_HAS_RESERVATIONS",
                409,
            )
        }
    }

    const desiredStatus = enabled
        ? MENU_INVENTORY_MAPPING_STATUSES.ACTIVE
        : MENU_INVENTORY_MAPPING_STATUSES.DISABLED
    const currentComponents = existing?.components?.map((component) => plain(component)) || []
    const mappingChanged = !existing ||
        existing.mode !== MENU_INVENTORY_MODES.RECIPE ||
        existing.status !== desiredStatus ||
        !componentsEqual(currentComponents, validated.components)

    let mapping = existing
    if (!mapping) {
        ;[mapping] = await MenuInventoryRecipeModel.create([{
            menuInventoryRecipeId: generateId(),
            businessId,
            menuItemId,
            mode: MENU_INVENTORY_MODES.RECIPE,
            status: desiredStatus,
            version: 1,
            components: validated.components,
            disabledReason: enabled ? null : "owner_disabled",
            disabledAt: enabled ? null : new Date(),
        }], { session })
    } else if (mappingChanged) {
        mapping.mode = MENU_INVENTORY_MODES.RECIPE
        mapping.status = desiredStatus
        mapping.components = validated.components
        mapping.version += 1
        mapping.migration = null
        mapping.creationRequestFingerprint = null
        mapping.disabledReason = enabled ? null : "owner_disabled"
        mapping.disabledAt = enabled ? null : new Date()
        await mapping.save({ session })
    }

    const menuItem = validated.menuItem
    const manualIsAvailable = resolveManualMenuAvailability(menuItem)
    const menuProjectionChanged = menuItem.trackStock !== false ||
        menuItem.stockQuantity !== null ||
        menuItem.lowStockThreshold !== null ||
        menuItem.manualIsAvailable !== manualIsAvailable ||
        menuItem.isAvailable !== manualIsAvailable
    if (menuProjectionChanged) {
        menuItem.trackStock = false
        menuItem.stockQuantity = null
        menuItem.lowStockThreshold = null
        menuItem.manualIsAvailable = manualIsAvailable
        menuItem.isAvailable = manualIsAvailable
        await menuItem.save({ session })
    }

    return {
        recipe: toIngredientRecipeDTO({
            mapping,
            menuItem,
            inventoryItems: validated.inventoryItems,
        }),
        replayed: !mappingChanged && !menuProjectionChanged,
    }
}

export async function upsertIngredientRecipe({
    businessId,
    menuItemId,
    components,
    enabled: enabledValue,
    replaceSimpleStock: replaceSimpleStockValue,
    replaceLegacyStock: replaceLegacyStockValue,
    session = null,
}, {
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    InventoryItemModel = InventoryItem,
    MenuItemModel = MenuItem,
    generateId = generateMenuInventoryRecipeId,
    transactionRunner = withCanonicalInventoryTransaction,
    invalidateMenu = invalidateMenuMutation,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const normalizedMenuItemId = normalizeMenuItemId(menuItemId)
    const enabled = normalizeBoolean(enabledValue, "enabled", true)
    const replaceSimpleStock = normalizeBoolean(
        replaceSimpleStockValue,
        "replaceSimpleStock",
        false,
    )
    const replaceLegacyStock = normalizeBoolean(
        replaceLegacyStockValue,
        "replaceLegacyStock",
        false,
    )
    const input = {
        businessId: tenantId,
        menuItemId: normalizedMenuItemId,
        components,
        enabled,
        replaceSimpleStock,
        replaceLegacyStock,
    }
    const dependencies = {
        MenuInventoryRecipeModel,
        InventoryItemModel,
        MenuItemModel,
        generateId,
    }
    const execute = (currentSession) => upsertIngredientRecipeWithinTransaction({
        ...input,
        session: currentSession,
    }, dependencies)
    const result = session ? await execute(session) : await transactionRunner(execute)
    if (!session && !result.replayed) await invalidateMenu(tenantId)
    return result
}

async function hydrateIngredientRecipes(mappings, {
    businessId,
    MenuItemModel,
    InventoryItemModel,
}) {
    if (mappings.length === 0) return []
    const menuItemIds = mappings.map((mapping) => mapping.menuItemId)
    const inventoryItemIds = [...new Set(mappings.flatMap(
        (mapping) => mapping.components.map((component) => component.inventoryItemId),
    ))]
    const [menuItems, inventoryItems] = await Promise.all([
        MenuItemModel.find({
            businessId,
            _id: { $in: menuItemIds },
            archivedAt: null,
        }).lean(),
        InventoryItemModel.find({
            businessId,
            inventoryItemId: { $in: inventoryItemIds },
        }).lean(),
    ])
    const menuById = new Map(menuItems.map((item) => [String(item._id), item]))
    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))
    return mappings.map((mapping) => toIngredientRecipeDTO({
        mapping,
        menuItem: menuById.get(String(mapping.menuItemId)) || null,
        inventoryItems: mapping.components.map(
            (component) => inventoryById.get(component.inventoryItemId),
        ).filter(Boolean),
    }))
}

function normalizeRecipeListLimit(value) {
    if (value === undefined || value === null || value === "") return 25
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw mappingError("limit must be a positive integer", "INVALID_RECIPE_QUERY")
    }
    return Math.min(parsed, 100)
}

export async function readIngredientRecipesPage({
    businessId,
    status,
    inventoryItemId,
    cursor,
    limit,
}, {
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    InventoryItemModel = InventoryItem,
    MenuItemModel = MenuItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const pageLimit = normalizeRecipeListLimit(limit)
    const normalizedInventoryItemId = inventoryItemId === undefined || inventoryItemId === null || inventoryItemId === ""
        ? null
        : requiredText(inventoryItemId, "inventoryItemId", 100)
    const normalizedStatus = status && status !== "all" ? status : null
    if (normalizedStatus && ![
        MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
    ].includes(normalizedStatus)) {
        throw mappingError("status must be active, disabled, or all", "INVALID_RECIPE_QUERY")
    }
    if (cursor && !mongoose.isValidObjectId(cursor)) {
        throw mappingError("cursor is invalid", "INVALID_RECIPE_QUERY")
    }
    const filter = {
        businessId: tenantId,
        mode: MENU_INVENTORY_MODES.RECIPE,
        status: normalizedStatus || { $ne: MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED },
    }
    if (normalizedInventoryItemId) {
        filter["components.inventoryItemId"] = normalizedInventoryItemId
    }
    if (cursor) filter._id = { $gt: new mongoose.Types.ObjectId(cursor) }
    const rows = await MenuInventoryRecipeModel.find(filter)
        .sort({ _id: 1 })
        .limit(pageLimit + 1)
        .lean()
    const hasNextPage = rows.length > pageLimit
    const pageRows = rows.slice(0, pageLimit)
    const recipes = await hydrateIngredientRecipes(pageRows, {
        businessId: tenantId,
        MenuItemModel,
        InventoryItemModel,
    })
    return {
        recipes,
        pagination: {
            limit: pageLimit,
            hasNextPage,
            nextCursor: hasNextPage ? String(pageRows.at(-1)._id) : null,
        },
    }
}

export async function readIngredientRecipe({ businessId, menuItemId }, {
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    InventoryItemModel = InventoryItem,
    MenuItemModel = MenuItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const normalizedMenuItemId = normalizeMenuItemId(menuItemId)
    const mapping = await MenuInventoryRecipeModel.findOne({
        businessId: tenantId,
        menuItemId: normalizedMenuItemId,
        mode: MENU_INVENTORY_MODES.RECIPE,
        status: { $ne: MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED },
    }).lean()
    if (!mapping) {
        throw mappingError("Ingredient recipe not found", "INGREDIENT_RECIPE_NOT_FOUND", 404)
    }
    const [recipe] = await hydrateIngredientRecipes([mapping], {
        businessId: tenantId,
        MenuItemModel,
        InventoryItemModel,
    })
    if (!recipe?.menuItem) {
        throw mappingError("Recipe menu item is unavailable", "RECIPE_LINKAGE_BROKEN", 409)
    }
    return recipe
}

export async function transitionMenuInventoryRecipe({
    businessId,
    menuInventoryRecipeId,
    targetStatus,
    session = null,
}, {
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    ...validationDependencies
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const mappingId = requiredText(
        menuInventoryRecipeId,
        "menuInventoryRecipeId",
        100,
    )
    const mapping = await MenuInventoryRecipeModel.findOne(
        { businessId: tenantId, menuInventoryRecipeId: mappingId },
        null,
        sessionOptions(session),
    )
    if (!mapping) {
        throw mappingError("Inventory mapping not found", "MENU_INVENTORY_MAPPING_NOT_FOUND", 404)
    }
    if (mapping.status === targetStatus) return toMenuInventoryRecipeDTO(mapping)

    const allowedTargets = STANDARD_LIFECYCLE_TRANSITIONS[mapping.status]
    if (!allowedTargets?.has(targetStatus)) {
        throw mappingError(
            `Inventory mapping cannot transition from ${mapping.status} to ${targetStatus}`,
            "INVALID_MENU_INVENTORY_MAPPING_TRANSITION",
            409,
        )
    }

    if (targetStatus === MENU_INVENTORY_MAPPING_STATUSES.ACTIVE) {
        const validationInput = {
            businessId: tenantId,
            menuItemId: mapping.menuItemId,
            components: mapping.components,
            session,
        }
        if (mapping.mode === MENU_INVENTORY_MODES.RECIPE) {
            await validateIngredientRecipeRelationship({
                ...validationInput,
                requireActiveInventoryItems: true,
            }, validationDependencies)
        } else {
            await validateSimpleMenuInventoryRelationship({
                ...validationInput,
                requireActiveInventoryItem: true,
            }, validationDependencies)
        }
    }

    mapping.status = targetStatus
    mapping.version += 1
    await mapping.save(sessionOptions(session))
    return toMenuInventoryRecipeDTO(mapping)
}
