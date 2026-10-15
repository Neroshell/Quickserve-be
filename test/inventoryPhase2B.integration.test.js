import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import {
    receiveInventory,
} from "../src/services/canonicalInventoryService.js"
import {
    migrateLegacyMenuItemToSimpleStock,
} from "../src/services/simpleStockMigrationService.js"
import {
    adjustSimpleStockMenuItem,
    archiveMappedMenuItem,
    createSimpleStockMenuItem,
    enrichMenuItemsWithInventory,
    executeInventoryMovementWithSimpleStockProjection,
    readSimpleStockDrift,
    reconcileSimpleStockProjection,
    rollbackSimpleStockToLegacy,
    setSimpleStockEnabled,
    setSimpleStockManualAvailability,
    updateSimpleStockThreshold,
} from "../src/services/simpleStockMenuService.js"
import {
    deductSimpleStockOrder,
    restoreSimpleStockOrder,
    validateSimpleStockOrder,
} from "../src/services/simpleStockOrderService.js"

const uri = process.env.INVENTORY_TEST_MONGODB_URI
const actor = { staffId: "owner_phase2b", role: "owner", name: "Phase 2B Owner" }

async function clearDatabase() {
    await Promise.all([
        InventoryMovement.collection.deleteMany({}),
        MenuInventoryRecipe.collection.deleteMany({}),
        Order.collection.deleteMany({}),
        MenuItem.collection.deleteMany({}),
        InventoryItem.collection.deleteMany({}),
    ])
}

async function createSimple({
    businessId = "biz_phase2b",
    name,
    quantity,
    threshold = 0,
    unit = "piece",
}) {
    return createSimpleStockMenuItem({
        businessId,
        input: {
            name,
            price: 4,
            prepTimeMinutes: 1,
            category: "drinks",
            type: "drinks",
            isAvailable: true,
            openingQuantity: quantity,
            lowStockThreshold: threshold,
            stockUnit: unit,
        },
        actor,
        idempotencyKey: `create:${businessId}:${name}`,
    })
}

async function createOrder({
    businessId = "biz_phase2b",
    orderId,
    items,
    status = "placed",
    inventoryDeducted = false,
    inventorySemanticsVersion,
    inventoryDeductionLines,
}) {
    return Order.create({
        businessId,
        orderId,
        servicePointLabel: "table_1",
        status,
        paymentChannel: "offline",
        paymentStatus: "unpaid",
        items: items.map((item) => ({
            menuItemId: item.menuItemId,
            itemName: item.itemName,
            quantity: item.quantity,
            lineTotal: item.quantity * 4,
            type: "drinks",
            category: "drinks",
        })),
        inventoryDeducted,
        ...(inventorySemanticsVersion ? { inventorySemanticsVersion } : {}),
        ...(inventoryDeductionLines ? { inventoryDeductionLines } : {}),
    })
}

test("Phase 2B Simple Stock cutover is transactional under a real replica set", {
    skip: uri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async (t) => {
    await mongoose.connect(uri, { dbName: `quickserve_inventory_phase2b_${Date.now()}` })
    try {
        await Promise.all([
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
            MenuInventoryRecipe.syncIndexes(),
            MenuItem.syncIndexes(),
            Order.syncIndexes(),
        ])

        await t.test("concurrent last-unit orders have exactly one winner", async () => {
            await clearDatabase()
            const created = await createSimple({ name: "Last Water", quantity: 1 })
            const itemId = created.item._id
            const [one, two] = await Promise.all([
                createOrder({
                    orderId: "ord_last_1",
                    items: [{ menuItemId: itemId, itemName: "Last Water", quantity: 1 }],
                }),
                createOrder({
                    orderId: "ord_last_2",
                    items: [{ menuItemId: itemId, itemName: "Last Water", quantity: 1 }],
                }),
            ])
            const results = await Promise.allSettled([
                deductSimpleStockOrder(one),
                deductSimpleStockOrder(two),
            ])
            assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
            assert.equal(results.filter((result) => result.status === "rejected").length, 1)
            const inventory = await InventoryItem.findOne({ businessId: "biz_phase2b" }).lean()
            assert.equal(inventory.onHandQuantity, 0)
            assert.equal(await InventoryMovement.countDocuments({ type: "LEGACY_ORDER_DEDUCTION" }), 1)
            assert.equal(await Order.countDocuments({ inventoryDeducted: true }), 1)
        })

        await t.test("multi-item mixed deduction and restoration are atomic and idempotent", async () => {
            await clearDatabase()
            const canonical = await createSimple({ name: "Canonical Can", quantity: 4, unit: "can" })
            const legacy = await MenuItem.create({
                businessId: "biz_phase2b",
                name: "Legacy Pack",
                price: 4,
                prepTimeMinutes: 1,
                category: "drinks",
                type: "drinks",
                trackStock: true,
                stockQuantity: 3,
                isAvailable: true,
            })
            const order = await createOrder({
                orderId: "ord_mixed",
                items: [
                    { menuItemId: canonical.item._id, itemName: "Canonical Can", quantity: 2 },
                    { menuItemId: legacy._id, itemName: "Legacy Pack", quantity: 2 },
                ],
            })
            assert.deepEqual(await validateSimpleStockOrder(order.items, order.businessId), [])
            assert.equal(await deductSimpleStockOrder(order), true)
            assert.equal(await deductSimpleStockOrder(order), true)

            const deducted = await Order.findOne({ orderId: "ord_mixed" }).lean()
            assert.equal(deducted.inventorySemanticsVersion, "mixed_bridge_v1")
            assert.equal(deducted.inventoryDeductionLines.length, 2)
            assert.equal((await InventoryItem.findOne({}).lean()).onHandQuantity, 2)
            assert.equal((await MenuItem.findById(legacy._id).lean()).stockQuantity, 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "LEGACY_ORDER_DEDUCTION" }), 1)

            assert.equal(await restoreSimpleStockOrder(order), true)
            assert.equal(await restoreSimpleStockOrder(order), true)
            const restored = await Order.findOne({ orderId: "ord_mixed" }).lean()
            assert.equal(restored.inventoryRestored, true)
            assert.ok(restored.inventoryDeductionLines.find((line) => line.inventoryItemId)?.restorationMovementId)
            assert.equal((await InventoryItem.findOne({}).lean()).onHandQuantity, 4)
            assert.equal((await MenuItem.findById(legacy._id).lean()).stockQuantity, 3)
            assert.equal(await InventoryMovement.countDocuments({ type: "LEGACY_ORDER_RESTORE" }), 1)
        })

        await t.test("a failure in any mixed line rolls back every mutation", async () => {
            await clearDatabase()
            const canonical = await createSimple({ name: "Atomic Bottle", quantity: 2, unit: "bottle" })
            const legacy = await MenuItem.create({
                businessId: "biz_phase2b",
                name: "Atomic Legacy",
                price: 4,
                prepTimeMinutes: 1,
                category: "drinks",
                type: "drinks",
                trackStock: true,
                stockQuantity: 1,
            })
            const order = await createOrder({
                orderId: "ord_atomic_failure",
                items: [
                    { menuItemId: canonical.item._id, itemName: "Atomic Bottle", quantity: 1 },
                    { menuItemId: legacy._id, itemName: "Atomic Legacy", quantity: 2 },
                ],
            })
            await assert.rejects(deductSimpleStockOrder(order), (error) => error.code === "INSUFFICIENT_STOCK")
            assert.equal((await InventoryItem.findOne({}).lean()).onHandQuantity, 2)
            assert.equal((await MenuItem.findById(legacy._id).lean()).stockQuantity, 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "LEGACY_ORDER_DEDUCTION" }), 0)
            assert.equal((await Order.findOne({ orderId: order.orderId }).lean()).inventoryDeducted, false)
        })

        await t.test("migration is deterministic, race-safe, and blocks open legacy cancellation risk", async () => {
            await clearDatabase()
            const legacy = await MenuItem.create({
                businessId: "biz_phase2b",
                name: "Migration Piece",
                price: 4,
                prepTimeMinutes: 1,
                category: "mains",
                type: "food",
                trackStock: true,
                stockQuantity: 8,
                lowStockThreshold: 0,
                isAvailable: true,
            })
            const [first, second] = await Promise.all([
                migrateLegacyMenuItemToSimpleStock({
                    businessId: "biz_phase2b", menuItemId: legacy._id, actor,
                }),
                migrateLegacyMenuItemToSimpleStock({
                    businessId: "biz_phase2b", menuItemId: legacy._id, actor,
                }),
            ])
            assert.equal([first, second].filter((result) => result.replayed).length, 1)
            assert.equal(await InventoryItem.countDocuments({}), 1)
            assert.equal(await MenuInventoryRecipe.countDocuments({ status: "active" }), 1)
            assert.equal(await InventoryMovement.countDocuments({ reasonCode: "opening_balance_correction" }), 1)

            const risky = await MenuItem.create({
                businessId: "biz_phase2b",
                name: "Risky Legacy",
                price: 4,
                prepTimeMinutes: 1,
                category: "mains",
                type: "food",
                trackStock: true,
                stockQuantity: 3,
            })
            await createOrder({
                orderId: "ord_open_legacy",
                items: [{ menuItemId: risky._id, itemName: risky.name, quantity: 1 }],
                inventoryDeducted: true,
            })
            await assert.rejects(
                migrateLegacyMenuItemToSimpleStock({
                    businessId: "biz_phase2b", menuItemId: risky._id, actor,
                }),
                (error) => error.code === "SIMPLE_STOCK_MIGRATION_BLOCKED" &&
                    error.classification.blockers.includes("OPEN_LEGACY_CANCELLATION_RISK"),
            )
        })

        await t.test("recorded legacy authority restores legacy stock after a later migration", async () => {
            await clearDatabase()
            const legacy = await MenuItem.create({
                businessId: "biz_phase2b",
                name: "Historic Legacy",
                price: 4,
                prepTimeMinutes: 1,
                category: "mains",
                type: "food",
                trackStock: true,
                stockQuantity: 4,
            })
            const order = await createOrder({
                orderId: "ord_historic_legacy",
                items: [{ menuItemId: legacy._id, itemName: legacy.name, quantity: 1 }],
                status: "in_progress",
            })
            await deductSimpleStockOrder(order)
            await migrateLegacyMenuItemToSimpleStock({
                businessId: "biz_phase2b", menuItemId: legacy._id, actor,
            })
            const beforeCanonical = (await InventoryItem.findOne({}).lean()).onHandQuantity
            await restoreSimpleStockOrder(order)
            assert.equal((await InventoryItem.findOne({}).lean()).onHandQuantity, beforeCanonical)
            assert.equal((await Order.findOne({ orderId: order.orderId }).lean()).inventoryRestored, true)
            assert.equal(await InventoryMovement.countDocuments({ type: "LEGACY_ORDER_RESTORE" }), 0)
        })

        await t.test("projection, manual availability, threshold zero, adjustments, disable, rollback, and archive", async () => {
            await clearDatabase()
            const created = await createSimple({ name: "Lifecycle Portion", quantity: 2, threshold: 0, unit: "portion" })
            const menuItemId = created.item._id
            assert.equal(created.item.inventory.isLowStock, false)
            await adjustSimpleStockMenuItem({
                businessId: "biz_phase2b",
                menuItemId,
                input: {
                    quantity: 2,
                    unit: "portion",
                    direction: "decrease",
                    reason: "data_correction",
                },
                actor,
                idempotencyKey: "lifecycle-adjust-zero",
            })
            let [projected] = await enrichMenuItemsWithInventory({
                businessId: "biz_phase2b",
                menuItems: [await MenuItem.findById(menuItemId)],
            })
            assert.equal(projected.stockQuantity, 0)
            assert.equal(projected.inventory.isLowStock, true)
            assert.equal(projected.isAvailable, false)

            await setSimpleStockManualAvailability({
                businessId: "biz_phase2b", menuItemId, isAvailable: false,
            })
            const mappedInventory = await InventoryItem.findOne({ businessId: "biz_phase2b" }).lean()
            await executeInventoryMovementWithSimpleStockProjection({
                businessId: "biz_phase2b",
                inventoryItemId: mappedInventory.inventoryItemId,
                input: {
                    quantity: 3,
                    unit: "portion",
                },
                actor,
                idempotencyKey: "lifecycle-adjust-three",
                command: receiveInventory,
            })
            projected = (await enrichMenuItemsWithInventory({
                businessId: "biz_phase2b",
                menuItems: [await MenuItem.findById(menuItemId)],
            }))[0]
            assert.equal(projected.stockQuantity, 3)
            assert.equal(projected.manualIsAvailable, false)
            assert.equal(projected.isAvailable, false)

            await updateSimpleStockThreshold({ businessId: "biz_phase2b", menuItemId, lowStockThreshold: 3 })
            assert.equal((await readSimpleStockDrift({ businessId: "biz_phase2b" })).drifted, 0)
            await MenuItem.updateOne({ _id: menuItemId }, { $set: { stockQuantity: 99 } })
            assert.equal((await readSimpleStockDrift({ businessId: "biz_phase2b" })).drifted, 1)
            await reconcileSimpleStockProjection({ businessId: "biz_phase2b", menuItemId })
            assert.equal((await readSimpleStockDrift({ businessId: "biz_phase2b" })).drifted, 0)
            await setSimpleStockManualAvailability({
                businessId: "biz_phase2b", menuItemId, isAvailable: true,
            })

            await setSimpleStockEnabled({ businessId: "biz_phase2b", menuItemId, enabled: false, actor })
            let mapping = await MenuInventoryRecipe.findOne({ menuItemId }).lean()
            assert.equal(mapping.status, "disabled")
            assert.equal((await MenuItem.findById(menuItemId).lean()).trackStock, false)
            await setSimpleStockEnabled({ businessId: "biz_phase2b", menuItemId, enabled: true, actor })
            assert.equal((await MenuInventoryRecipe.findOne({ menuItemId }).lean()).status, "active")

            const openOrder = await createOrder({
                orderId: "ord_blocks_rollback",
                items: [{ menuItemId, itemName: "Lifecycle Portion", quantity: 1 }],
            })
            await deductSimpleStockOrder(openOrder)
            await assert.rejects(
                rollbackSimpleStockToLegacy({ businessId: "biz_phase2b", menuItemId }),
                (error) => error.code === "OPEN_CANONICAL_CANCELLATION_RISK",
            )
            await restoreSimpleStockOrder(openOrder)
            await rollbackSimpleStockToLegacy({ businessId: "biz_phase2b", menuItemId })
            mapping = await MenuInventoryRecipe.findOne({ menuItemId }).lean()
            assert.equal(mapping.disabledReason, "legacy_rollback")
            assert.equal((await MenuItem.findById(menuItemId).lean()).trackStock, true)
            await setSimpleStockEnabled({ businessId: "biz_phase2b", menuItemId, enabled: true, actor })
            assert.equal((await MenuInventoryRecipe.findOne({ menuItemId }).lean()).status, "active")

            await archiveMappedMenuItem({ businessId: "biz_phase2b", menuItemId })
            assert.equal((await MenuInventoryRecipe.findOne({ menuItemId }).lean()).status, "archived")
            assert.ok((await MenuItem.findById(menuItemId).lean()).archivedAt)
            assert.equal(await InventoryItem.countDocuments({}), 1)
            assert.ok(await InventoryMovement.countDocuments({}) >= 3)
        })

        await t.test("tenant boundaries and kill switch fail closed", async () => {
            await clearDatabase()
            const created = await createSimple({ businessId: "biz_alpha", name: "Tenant Bottle", quantity: 2, unit: "bottle" })
            const item = await MenuItem.findById(created.item._id)
            assert.deepEqual(await validateSimpleStockOrder([{
                menuItemId: item._id,
                itemName: item.name,
                quantity: 1,
            }], "biz_beta"), [{
                menuItemId: item._id,
                itemName: item.name,
                requested: 1,
                available: 0,
                reason: "MENU_ITEM_NOT_FOUND",
            }])
            await assert.rejects(
                validateSimpleStockOrder([{
                    menuItemId: item._id,
                    itemName: item.name,
                    quantity: 1,
                }], "biz_alpha", { env: { SIMPLE_STOCK_KILL_SWITCH: "true" } }),
                (error) => error.code === "SIMPLE_STOCK_KILL_SWITCH_ACTIVE",
            )
            await assert.rejects(
                adjustSimpleStockMenuItem({
                    businessId: "biz_beta",
                    menuItemId: item._id,
                    input: { quantity: 1, unit: "bottle", direction: "increase", reason: "data_correction" },
                    actor,
                    idempotencyKey: "cross-tenant-adjust",
                }),
                (error) => error.code === "SIMPLE_STOCK_MAPPING_NOT_FOUND",
            )
        })
    } finally {
        await mongoose.connection.db.dropDatabase()
        await mongoose.disconnect()
    }
})
