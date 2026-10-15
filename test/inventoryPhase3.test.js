import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
    MENU_INVENTORY_TRACKING_STATES,
} from "../src/constants/menuInventory.js"
import { PERMISSIONS, normalizePermissions } from "../src/constants/permissions.js"
import {
    resolveEffectiveMenuAvailability,
    toMenuItemWithInventoryDTO,
} from "../src/services/menuInventoryAvailabilityService.js"
import {
    RECIPE_COST_STATUSES,
    calculateIngredientRecipeCost,
    validateIngredientRecipeRelationship,
} from "../src/services/menuInventoryRecipeService.js"

const menuItemId = new mongoose.Types.ObjectId()

function validationDependencies({ tenant = "biz_recipe" } = {}) {
    const menuItem = {
        _id: menuItemId,
        businessId: tenant,
        archivedAt: null,
        name: "Burger",
    }
    const inventoryItems = [
        {
            businessId: tenant,
            inventoryItemId: "inv_beef",
            name: "Beef",
            trackingUnit: "g",
            isActive: true,
        },
        {
            businessId: tenant,
            inventoryItemId: "inv_sauce",
            name: "Sauce",
            trackingUnit: "ml",
            isActive: true,
        },
    ]
    return {
        MenuItemModel: {
            async findOne(filter) {
                return filter.businessId === tenant ? menuItem : null
            },
        },
        InventoryItemModel: {
            async find(filter) {
                if (filter.businessId !== tenant) return []
                const requested = new Set(filter.inventoryItemId.$in)
                return inventoryItems.filter((item) => requested.has(item.inventoryItemId))
            },
        },
    }
}

test("ingredient recipe validation normalizes compatible UOMs and preserves component order", async () => {
    const result = await validateIngredientRecipeRelationship({
        businessId: "biz_recipe",
        menuItemId,
        components: [
            { inventoryItemId: "inv_beef", quantity: 0.15, unit: "kg" },
            { inventoryItemId: "inv_sauce", quantity: 0.02, unit: "L" },
        ],
    }, validationDependencies())

    assert.deepEqual(result.components, [
        { inventoryItemId: "inv_beef", quantity: 0.15, unit: "kg", canonicalQuantity: 150 },
        { inventoryItemId: "inv_sauce", quantity: 0.02, unit: "L", canonicalQuantity: 20 },
    ])

    await assert.rejects(
        validateIngredientRecipeRelationship({
            businessId: "biz_recipe",
            menuItemId,
            components: [
                { inventoryItemId: "inv_beef", quantity: 10, unit: "g" },
                { inventoryItemId: "inv_beef", quantity: 20, unit: "g" },
            ],
        }, validationDependencies()),
        (error) => error.code === "DUPLICATE_RECIPE_COMPONENT",
    )
    await assert.rejects(
        validateIngredientRecipeRelationship({
            businessId: "biz_recipe",
            menuItemId,
            components: [{ inventoryItemId: "inv_beef", quantity: 1, unit: "L" }],
        }, validationDependencies()),
        (error) => error.code === "INCOMPATIBLE_INVENTORY_UNIT",
    )
    await assert.rejects(
        validateIngredientRecipeRelationship({
            businessId: "biz_other",
            menuItemId,
            components: [{ inventoryItemId: "inv_beef", quantity: 10, unit: "g" }],
        }, validationDependencies()),
        (error) => error.code === "MENU_ITEM_NOT_FOUND",
    )
})

test("recipe costing is exact, explicit about missing costs, and rejects mixed currencies", () => {
    const components = [
        { inventoryItemId: "inv_beef", canonicalQuantity: 150 },
        { inventoryItemId: "inv_sauce", canonicalQuantity: 20 },
    ]
    const complete = calculateIngredientRecipeCost({
        components,
        inventoryItems: [
            { inventoryItemId: "inv_beef", unitCostMinor: 2, costCurrency: "EUR" },
            { inventoryItemId: "inv_sauce", unitCostMinor: 1, costCurrency: "EUR" },
        ],
    })
    assert.equal(complete.status, RECIPE_COST_STATUSES.COMPLETE)
    assert.equal(complete.estimatedCostMinor, 320)
    assert.equal(complete.currency, "EUR")

    const missing = calculateIngredientRecipeCost({
        components,
        inventoryItems: [
            { inventoryItemId: "inv_beef", unitCostMinor: 2, costCurrency: "EUR" },
            { inventoryItemId: "inv_sauce", unitCostMinor: null, costCurrency: null },
        ],
    })
    assert.equal(missing.status, RECIPE_COST_STATUSES.MISSING_COST)
    assert.equal(missing.estimatedCostMinor, null)
    assert.deepEqual(missing.missingCostInventoryItemIds, ["inv_sauce"])

    const mixed = calculateIngredientRecipeCost({
        components,
        inventoryItems: [
            { inventoryItemId: "inv_beef", unitCostMinor: 2, costCurrency: "EUR" },
            { inventoryItemId: "inv_sauce", unitCostMinor: 1, costCurrency: "USD" },
        ],
    })
    assert.equal(mixed.status, RECIPE_COST_STATUSES.MIXED_CURRENCY)
    assert.equal(mixed.estimatedCostMinor, null)
})

test("active recipe ingredients are operational tracking, not a sales gate", () => {
    const mapping = {
        mode: MENU_INVENTORY_MODES.RECIPE,
        status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        components: [
            { inventoryItemId: "inv_beef", quantity: 150, unit: "g", canonicalQuantity: 150 },
            { inventoryItemId: "inv_sauce", quantity: 20, unit: "ml", canonicalQuantity: 20 },
        ],
    }
    const menuItem = {
        _id: menuItemId,
        manualIsAvailable: true,
        isAvailable: true,
        trackStock: false,
        stockQuantity: null,
    }
    const availability = resolveEffectiveMenuAvailability({ menuItem, mapping })
    assert.equal(availability.trackingState, MENU_INVENTORY_TRACKING_STATES.CANONICAL_RECIPE)
    assert.equal(availability.inventoryAvailabilityState, "unavailable")
    assert.equal(availability.availableMenuQuantity, 0)
    assert.equal(availability.effectiveIsAvailable, true)

    const dto = toMenuItemWithInventoryDTO({ menuItem, mapping, inventoryItems: [] })
    assert.equal(dto.inventory.mode, MENU_INVENTORY_MODES.RECIPE)
    assert.equal(dto.inventory.recipeComponentCount, 2)
    assert.equal(dto.inventory.inventoryItemId, null)
    assert.equal(dto.inventory.ingredientTracking.behavior, "sidecar")
    assert.equal(dto.inventory.ingredientAvailabilityEnforced, false)
    assert.equal(dto.stockQuantity, null)
})

test("recipe APIs use the dedicated permission and do not introduce future movement semantics", async () => {
    assert.deepEqual(
        normalizePermissions([PERMISSIONS.INVENTORY_RECIPE_MANAGE]),
        [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_RECIPE_MANAGE],
    )
    const routes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    assert.match(routes, /\/inventory\/recipes/)
    assert.match(routes, /PERMISSIONS\.INVENTORY_RECIPE_MANAGE/)

    const recipeService = await readFile(
        new URL("../src/services/menuInventoryRecipeService.js", import.meta.url),
        "utf8",
    )
    assert.doesNotMatch(
        recipeService,
        /INVENTORY_MOVEMENT_TYPES\.(RESERVE|RELEASE|CONSUME)/,
    )
    const orderService = await readFile(
        new URL("../src/services/simpleStockOrderService.js", import.meta.url),
        "utf8",
    )
    assert.match(orderService, /Phase 3 recipes are configuration and costing definitions only/)
})
