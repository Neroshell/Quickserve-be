import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import {
    adjustInventory,
    createInventoryItem,
    withCanonicalInventoryTransaction,
} from "../src/services/canonicalInventoryService.js"
import { createSimpleMenuInventoryRecipe } from "../src/services/menuInventoryRecipeService.js"

const transactionTestUri = process.env.INVENTORY_TEST_MONGODB_URI

test("Phase 2A composite primitives atomically create a disabled mapping foundation", {
    skip: transactionTestUri
        ? false
        : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    const databaseName = `quickserve_inventory_phase2a_${Date.now()}`
    await mongoose.connect(transactionTestUri, { dbName: databaseName })
    try {
        await Promise.all([
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
            MenuInventoryRecipe.syncIndexes(),
            MenuItem.syncIndexes(),
        ])
        const menuItem = await MenuItem.create({
            businessId: "biz_phase2a",
            name: "Test Water",
            price: 3,
            prepTimeMinutes: 1,
            category: "drinks",
            type: "drinks",
            trackStock: true,
            stockQuantity: 12,
            lowStockThreshold: 3,
        })
        const actor = { staffId: "owner_phase2a", role: "owner", name: "Owner" }

        await withCanonicalInventoryTransaction(async (session) => {
            await createInventoryItem({
                businessId: "biz_phase2a",
                input: {
                    name: "Test Water",
                    trackingUnit: "piece",
                    lowStockThreshold: 3,
                },
                session,
            }, { generateId: () => "inv_phase2a_water" })
            await adjustInventory({
                businessId: "biz_phase2a",
                inventoryItemId: "inv_phase2a_water",
                input: {
                    quantity: 12,
                    unit: "piece",
                    direction: "increase",
                    reason: "opening_balance_correction",
                    reference: String(menuItem._id),
                },
                actor,
                idempotencyKey: "phase2a-opening-water",
                session,
            }, { generateMovementId: () => "imv_phase2a_water" })
            await createSimpleMenuInventoryRecipe({
                businessId: "biz_phase2a",
                menuItemId: menuItem._id,
                components: [{
                    inventoryItemId: "inv_phase2a_water",
                    quantity: 1,
                    unit: "piece",
                }],
                session,
            }, { generateId: () => "mir_phase2a_water" })
        })

        const item = await InventoryItem.findOne({ inventoryItemId: "inv_phase2a_water" }).lean()
        const mapping = await MenuInventoryRecipe.findOne({ menuItemId: menuItem._id }).lean()
        assert.equal(item.onHandQuantity, 12)
        assert.equal(await InventoryMovement.countDocuments({ inventoryItemId: item.inventoryItemId }), 1)
        assert.equal(mapping.status, "disabled")

        const rollbackMenu = await MenuItem.create({
            businessId: "biz_phase2a",
            name: "Rollback Item",
            price: 4,
            prepTimeMinutes: 1,
            category: "mains",
            type: "food",
        })
        await assert.rejects(
            withCanonicalInventoryTransaction(async (session) => {
                await createInventoryItem({
                    businessId: "biz_phase2a",
                    input: { name: "Rollback Item", trackingUnit: "piece" },
                    session,
                }, { generateId: () => "inv_phase2a_rollback" })
                await createSimpleMenuInventoryRecipe({
                    businessId: "biz_phase2a",
                    menuItemId: rollbackMenu._id,
                    components: [{
                        inventoryItemId: "inv_phase2a_rollback",
                        quantity: 1,
                        unit: "piece",
                    }],
                    session,
                }, { generateId: () => "mir_phase2a_rollback" })
                throw new Error("force composite rollback")
            }),
            /force composite rollback/,
        )
        assert.equal(await InventoryItem.exists({ inventoryItemId: "inv_phase2a_rollback" }), null)
        assert.equal(await MenuInventoryRecipe.exists({ menuItemId: rollbackMenu._id }), null)
    } finally {
        await mongoose.connection.db.dropDatabase()
        await mongoose.disconnect()
    }
})
