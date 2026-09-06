import assert from "node:assert/strict"
import test from "node:test"

import { readIngredientRecipesPage } from "../src/services/menuInventoryRecipeService.js"

const MENU_ITEM_ID = "507f1f77bcf86cd799439021"
const MAPPING_ID = "507f1f77bcf86cd799439022"

function leanQuery(rows, capture) {
    return {
        sort(value) {
            capture.sort = value
            return this
        },
        limit(value) {
            capture.limit = value
            return this
        },
        async lean() {
            return rows
        },
    }
}

test("linked recipe reads are tenant and inventory-item scoped", async () => {
    const mappingCapture = {}
    const menuCapture = {}
    const inventoryCapture = {}
    const mapping = {
        _id: MAPPING_ID,
        menuInventoryRecipeId: "mir_phase6b",
        businessId: "biz_alpha",
        menuItemId: MENU_ITEM_ID,
        mode: "recipe",
        status: "active",
        version: 1,
        components: [{
            inventoryItemId: "inv_tomato",
            quantity: 100,
            unit: "g",
            canonicalQuantity: 100,
        }],
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    }
    const menuItem = {
        _id: MENU_ITEM_ID,
        businessId: "biz_alpha",
        name: "Tomato Salad",
        category: "Starters",
        type: "food",
        price: 12,
        isAvailable: true,
    }
    const inventoryItem = {
        inventoryItemId: "inv_tomato",
        businessId: "biz_alpha",
        name: "Tomatoes",
        trackingUnit: "g",
        unitCostMinor: 1,
        costCurrency: "EUR",
        isActive: true,
    }
    const result = await readIngredientRecipesPage({
        businessId: "biz_alpha",
        inventoryItemId: "inv_tomato",
        limit: 10,
    }, {
        MenuInventoryRecipeModel: {
            find(filter) {
                mappingCapture.filter = filter
                return leanQuery([mapping], mappingCapture)
            },
        },
        MenuItemModel: {
            find(filter) {
                menuCapture.filter = filter
                return { lean: async () => [menuItem] }
            },
        },
        InventoryItemModel: {
            find(filter) {
                inventoryCapture.filter = filter
                return { lean: async () => [inventoryItem] }
            },
        },
    })

    assert.equal(mappingCapture.filter.businessId, "biz_alpha")
    assert.equal(mappingCapture.filter.$or[0].mode, "recipe")
    assert.equal(mappingCapture.filter.$or[0]["components.inventoryItemId"], "inv_tomato")
    assert.deepEqual(mappingCapture.filter.$or[0].status, { $ne: "archived" })
    assert.equal(mappingCapture.filter.$or[1].mode, "simple")
    assert.equal(
        mappingCapture.filter.$or[1]["ingredientComponents.inventoryItemId"],
        "inv_tomato",
    )
    assert.deepEqual(mappingCapture.sort, { _id: 1 })
    assert.equal(mappingCapture.limit, 11)
    assert.equal(menuCapture.filter.businessId, "biz_alpha")
    assert.equal(inventoryCapture.filter.businessId, "biz_alpha")
    assert.equal(result.recipes[0].menuItem.name, "Tomato Salad")
    assert.equal(result.recipes[0].components[0].inventoryItemName, "Tomatoes")
    assert.equal(result.pagination.hasNextPage, false)
})

test("linked recipe reads reject invalid inventory item filters", async () => {
    await assert.rejects(
        readIngredientRecipesPage({
            businessId: "biz_alpha",
            inventoryItemId: "x".repeat(101),
        }),
        (error) => error.code === "INVALID_MENU_INVENTORY_MAPPING" && /inventoryItemId/.test(error.message),
    )
})
