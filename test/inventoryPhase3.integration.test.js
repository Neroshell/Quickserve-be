import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../src/constants/menuInventory.js"
import {
    readIngredientRecipe,
    readIngredientRecipesPage,
    upsertIngredientRecipe,
} from "../src/services/menuInventoryRecipeService.js"
import { archiveMappedMenuItem } from "../src/services/simpleStockMenuService.js"
import {
    deductSimpleStockOrder,
    validateSimpleStockOrder,
} from "../src/services/simpleStockOrderService.js"

const uri = process.env.INVENTORY_TEST_MONGODB_URI

async function clearDatabase() {
    await Promise.all([
        InventoryMovement.collection.deleteMany({}),
        MenuInventoryRecipe.collection.deleteMany({}),
        Order.collection.deleteMany({}),
        MenuItem.collection.deleteMany({}),
        InventoryItem.collection.deleteMany({}),
    ])
}

function menuInput({ businessId = "biz_recipe", name = "Classic Burger", trackStock = false } = {}) {
    return {
        businessId,
        name,
        description: "",
        price: 12,
        prepTimeMinutes: 10,
        category: "mains",
        type: "food",
        isAvailable: true,
        manualIsAvailable: true,
        trackStock,
        stockQuantity: trackStock ? 5 : null,
    }
}

function inventoryInput({
    businessId = "biz_recipe",
    inventoryItemId,
    name,
    trackingUnit,
    unitCostMinor,
    costCurrency = "EUR",
}) {
    return {
        businessId,
        inventoryItemId,
        name,
        trackingUnit,
        baseUnitDimension: trackingUnit === "g" ? "weight" : "volume",
        onHandQuantity: 10000,
        reservedQuantity: 0,
        lowStockThreshold: 0,
        unitCostMinor,
        costCurrency,
        isActive: true,
    }
}

test("Phase 3 ingredient recipes are transactional canonical configuration", {
    skip: uri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async (t) => {
    await mongoose.connect(uri, { dbName: `quickserve_inventory_phase3_${Date.now()}` })
    try {
        await Promise.all([
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
            MenuInventoryRecipe.syncIndexes(),
            MenuItem.syncIndexes(),
            Order.syncIndexes(),
        ])

        await t.test("upsert normalizes ingredients, calculates cost, and replays idempotently", async () => {
            await clearDatabase()
            const menuItem = await MenuItem.create(menuInput())
            await InventoryItem.create([
                inventoryInput({
                    inventoryItemId: "inv_beef",
                    name: "Beef",
                    trackingUnit: "g",
                    unitCostMinor: 2,
                }),
                inventoryInput({
                    inventoryItemId: "inv_sauce",
                    name: "Burger Sauce",
                    trackingUnit: "ml",
                    unitCostMinor: 1,
                }),
            ])

            const input = {
                businessId: "biz_recipe",
                menuItemId: menuItem._id,
                components: [
                    { inventoryItemId: "inv_beef", quantity: 0.15, unit: "kg" },
                    { inventoryItemId: "inv_sauce", quantity: 20, unit: "ml" },
                ],
            }
            const created = await upsertIngredientRecipe(input)
            assert.equal(created.replayed, false)
            assert.equal(created.recipe.mode, MENU_INVENTORY_MODES.RECIPE)
            assert.equal(created.recipe.status, MENU_INVENTORY_MAPPING_STATUSES.ACTIVE)
            assert.deepEqual(
                created.recipe.components.map((component) => component.canonicalQuantity),
                [150, 20],
            )
            assert.equal(created.recipe.costing.estimatedCostMinor, 320)
            assert.equal(created.recipe.costing.currency, "EUR")

            const projectedMenu = await MenuItem.findById(menuItem._id).lean()
            assert.equal(projectedMenu.trackStock, false)
            assert.equal(projectedMenu.stockQuantity, null)
            assert.equal(projectedMenu.lowStockThreshold, null)
            assert.equal(projectedMenu.isAvailable, true)

            const replay = await upsertIngredientRecipe(input)
            assert.equal(replay.replayed, true)
            assert.equal(replay.recipe.version, 1)

            const updated = await upsertIngredientRecipe({
                ...input,
                components: [
                    { inventoryItemId: "inv_beef", quantity: 0.2, unit: "kg" },
                    { inventoryItemId: "inv_sauce", quantity: 25, unit: "ml" },
                ],
            })
            assert.equal(updated.recipe.version, 2)
            assert.equal(updated.recipe.costing.estimatedCostMinor, 425)

            const detail = await readIngredientRecipe({
                businessId: "biz_recipe",
                menuItemId: menuItem._id,
            })
            assert.equal(detail.menuItem.name, "Classic Burger")
            assert.equal(detail.components[0].inventoryItemName, "Beef")

            const page = await readIngredientRecipesPage({
                businessId: "biz_recipe",
                status: "active",
                limit: 10,
            })
            assert.equal(page.recipes.length, 1)
            assert.equal(page.pagination.hasNextPage, false)
        })

        await t.test("tenant boundaries and explicit legacy replacement are enforced", async () => {
            await clearDatabase()
            const legacyMenu = await MenuItem.create(menuInput({ trackStock: true }))
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_local",
                name: "Local ingredient",
                trackingUnit: "g",
                unitCostMinor: 1,
            }))
            await InventoryItem.create(inventoryInput({
                businessId: "biz_other",
                inventoryItemId: "inv_other",
                name: "Other tenant ingredient",
                trackingUnit: "g",
                unitCostMinor: 1,
            }))

            await assert.rejects(
                upsertIngredientRecipe({
                    businessId: "biz_recipe",
                    menuItemId: legacyMenu._id,
                    components: [{ inventoryItemId: "inv_local", quantity: 10, unit: "g" }],
                }),
                (error) => error.code === "LEGACY_STOCK_REPLACEMENT_CONFIRMATION_REQUIRED",
            )
            await assert.rejects(
                upsertIngredientRecipe({
                    businessId: "biz_recipe",
                    menuItemId: legacyMenu._id,
                    components: [{ inventoryItemId: "inv_other", quantity: 10, unit: "g" }],
                    replaceLegacyStock: true,
                }),
                (error) => error.code === "INVENTORY_ITEM_NOT_FOUND",
            )

            const replaced = await upsertIngredientRecipe({
                businessId: "biz_recipe",
                menuItemId: legacyMenu._id,
                components: [{ inventoryItemId: "inv_local", quantity: 10, unit: "g" }],
                replaceLegacyStock: true,
            })
            assert.equal(replaced.recipe.mode, MENU_INVENTORY_MODES.RECIPE)
            const menuAfter = await MenuItem.findById(legacyMenu._id).lean()
            assert.equal(menuAfter.trackStock, false)
            assert.equal(menuAfter.stockQuantity, null)
        })

        await t.test("configured recipes do not mutate ingredients or future movement semantics", async () => {
            await clearDatabase()
            const menuItem = await MenuItem.create(menuInput())
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_beef",
                name: "Beef",
                trackingUnit: "g",
                unitCostMinor: 2,
            }))
            await upsertIngredientRecipe({
                businessId: "biz_recipe",
                menuItemId: menuItem._id,
                components: [{ inventoryItemId: "inv_beef", quantity: 150, unit: "g" }],
            })
            const order = await Order.create({
                businessId: "biz_recipe",
                orderId: "ord_recipe_phase3",
                servicePointLabel: "table_1",
                status: "placed",
                paymentChannel: "offline",
                paymentStatus: "unpaid",
                items: [{
                    menuItemId: menuItem._id,
                    itemName: menuItem.name,
                    quantity: 2,
                    lineTotal: 24,
                    type: "food",
                    category: "mains",
                }],
            })

            assert.deepEqual(await validateSimpleStockOrder(order.items, "biz_recipe"), [])
            assert.equal(await deductSimpleStockOrder(order), false)
            const ingredient = await InventoryItem.findOne({ inventoryItemId: "inv_beef" }).lean()
            const persistedOrder = await Order.findById(order._id).lean()
            assert.equal(ingredient.onHandQuantity, 10000)
            assert.equal(persistedOrder.inventoryDeducted, false)
            assert.equal(await InventoryMovement.countDocuments({ businessId: "biz_recipe" }), 0)
        })

        await t.test("recipe-linked menu deletion archives linkage without deleting ingredients", async () => {
            await clearDatabase()
            const menuItem = await MenuItem.create(menuInput())
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_beef",
                name: "Beef",
                trackingUnit: "g",
                unitCostMinor: 2,
            }))
            await upsertIngredientRecipe({
                businessId: "biz_recipe",
                menuItemId: menuItem._id,
                components: [{ inventoryItemId: "inv_beef", quantity: 150, unit: "g" }],
            })
            await archiveMappedMenuItem({ businessId: "biz_recipe", menuItemId: menuItem._id })

            const [mapping, archivedMenu, ingredient] = await Promise.all([
                MenuInventoryRecipe.findOne({ businessId: "biz_recipe", menuItemId: menuItem._id }).lean(),
                MenuItem.findById(menuItem._id).lean(),
                InventoryItem.findOne({ businessId: "biz_recipe", inventoryItemId: "inv_beef" }).lean(),
            ])
            assert.equal(mapping.status, MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED)
            assert.ok(archivedMenu.archivedAt)
            assert.ok(ingredient)
        })
    } finally {
        await mongoose.connection.dropDatabase()
        await mongoose.disconnect()
    }
})
