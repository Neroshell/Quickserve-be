import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import {
    createInventoryItem,
    receiveInventory,
    recordInventoryWaste,
} from "../src/services/canonicalInventoryService.js"

const transactionTestUri = process.env.INVENTORY_TEST_MONGODB_URI

test("inventory balances and movements are atomic under real Mongo transactions", {
    skip: transactionTestUri
        ? false
        : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    const databaseName = `quickserve_inventory_test_${Date.now()}`
    await mongoose.connect(transactionTestUri, { dbName: databaseName })
    try {
        await Promise.all([
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
        ])
        const item = await createInventoryItem({
            businessId: "biz_inventory_test",
            input: {
                name: "Integration Flour",
                trackingUnit: "g",
                lowStockThreshold: 100,
            },
        })
        const actor = { staffId: "owner_test", role: "owner", name: "Test Owner" }
        const received = await receiveInventory({
            businessId: "biz_inventory_test",
            inventoryItemId: item.inventoryItemId,
            input: { quantity: 1, unit: "kg" },
            actor,
            idempotencyKey: "integration-receive",
        })
        assert.equal(received.item.onHandQuantity, 1000)

        const replay = await receiveInventory({
            businessId: "biz_inventory_test",
            inventoryItemId: item.inventoryItemId,
            input: { quantity: 1, unit: "kg" },
            actor,
            idempotencyKey: "integration-receive",
        })
        assert.equal(replay.replayed, true)

        const concurrent = await Promise.allSettled([
            recordInventoryWaste({
                businessId: "biz_inventory_test",
                inventoryItemId: item.inventoryItemId,
                input: { quantity: 600, unit: "g", reason: "spoilage" },
                actor,
                idempotencyKey: "integration-waste-a",
            }),
            recordInventoryWaste({
                businessId: "biz_inventory_test",
                inventoryItemId: item.inventoryItemId,
                input: { quantity: 600, unit: "g", reason: "damaged" },
                actor,
                idempotencyKey: "integration-waste-b",
            }),
        ])
        assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1)
        assert.equal(concurrent.filter(({ status }) => status === "rejected").length, 1)

        const storedItem = await InventoryItem.findOne({
            businessId: "biz_inventory_test",
            inventoryItemId: item.inventoryItemId,
        }).lean()
        assert.equal(storedItem.onHandQuantity, 400)
        assert.equal(storedItem.reservedQuantity, 0)
        assert.equal(await InventoryMovement.countDocuments({ businessId: "biz_inventory_test" }), 2)
    } finally {
        await mongoose.connection.db.dropDatabase()
        await mongoose.disconnect()
    }
})
