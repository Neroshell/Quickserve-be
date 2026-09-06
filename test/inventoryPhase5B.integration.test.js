import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import {
    INVENTORY_LINE_ALLOCATION_STATUSES,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_SOURCE_TYPES,
    INVENTORY_RESERVATION_STATUSES,
} from "../src/constants/inventoryReservation.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import Order from "../src/models/order.js"
import { withCanonicalInventoryTransaction } from "../src/services/canonicalInventoryService.js"
import { releaseInventoryReservationWithinTransaction } from "../src/services/inventoryReservationService.js"
import { transitionOrderFulfillment } from "../src/services/orderFulfillmentService.js"

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI
const fingerprint = "c".repeat(64)
const actor = { staffId: "manager_phase5b", role: "manager", name: "Phase 5B Manager" }

function orderLine({ orderLineId, menuItemId, station, behavior, quantity = 1 }) {
    return {
        orderLineId,
        menuItemId,
        itemName: orderLineId,
        quantity,
        lineTotal: 10,
        type: station === "bar" ? "drinks" : "food",
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        fulfillmentStatus: "pending",
    }
}

function lineAllocation({
    allocationId,
    orderLineId,
    menuItemId,
    station,
    behavior,
    inventoryItemId,
    quantity,
    unit,
}) {
    return {
        allocationId,
        orderLineId,
        menuItemId,
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        inventoryItemId,
        canonicalQuantity: quantity,
        unit,
        status: INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
    }
}

async function createCanonicalOrder({ orderId, reservationId, items }) {
    return Order.create({
        orderId,
        businessId: "biz_phase5b_integration",
        servicePointLabel: "sp_phase5b",
        status: "placed",
        paymentChannel: "offline",
        paymentStatus: "unpaid",
        inventoryReservationId: reservationId,
        inventoryReserved: true,
        inventoryReservedAt: new Date(),
        inventorySemanticsVersion: "canonical_reservation_v1",
        items,
    })
}

async function createCommittedReservation({
    reservationId,
    orderId,
    components,
    lineAllocations,
    menuItemIds,
}) {
    return InventoryReservation.create({
        reservationId,
        businessId: "biz_phase5b_integration",
        sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
        sourceId: orderId,
        orderId,
        status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
        components: components.map((component) => ({
            ...component,
            reserveMovementId: `imv_reserve_${reservationId}_${component.inventoryItemId}`,
        })),
        lineAllocations,
        menuRequirements: menuItemIds.map((menuItemId) => ({
            menuItemId,
            orderQuantity: 1,
            authority: "canonical",
            mappingMode: "recipe",
            mappingVersion: 1,
        })),
        idempotencyKey: `phase5b:${reservationId}`,
        requestFingerprint: fingerprint,
        committedAt: new Date(),
    })
}

test("Phase 5B transactions preserve exact balances under concurrency and rollback", {
    skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    const dbName = `quickserve_inventory_phase5b_${Date.now()}`
    await mongoose.connect(mongoUri, { dbName })
    try {
        await Promise.all([
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
            InventoryReservation.syncIndexes(),
            Order.syncIndexes(),
        ])

        // Kitchen and Bar own separate allocations of one shared InventoryItem.
        const burgerId = new mongoose.Types.ObjectId()
        const directDrinkId = new mongoose.Types.ObjectId()
        await InventoryItem.create({
            inventoryItemId: "inv_phase5b_shared",
            businessId: "biz_phase5b_integration",
            name: "Shared stock",
            trackingUnit: "g",
            baseUnitDimension: "weight",
            onHandQuantity: 1000,
            reservedQuantity: 150,
            lowStockThreshold: 0,
        })
        await createCanonicalOrder({
            orderId: "ord_phase5b_concurrent",
            reservationId: "irv_phase5b_concurrent",
            items: [
                orderLine({
                    orderLineId: "line_phase5b_kitchen",
                    menuItemId: burgerId,
                    station: "kitchen",
                    behavior: "prepared",
                }),
                orderLine({
                    orderLineId: "line_phase5b_bar",
                    menuItemId: directDrinkId,
                    station: "bar",
                    behavior: "direct",
                }),
            ],
        })
        await createCommittedReservation({
            reservationId: "irv_phase5b_concurrent",
            orderId: "ord_phase5b_concurrent",
            components: [{
                inventoryItemId: "inv_phase5b_shared",
                canonicalQuantity: 150,
                unit: "g",
            }],
            lineAllocations: [
                lineAllocation({
                    allocationId: "allocation_phase5b_kitchen",
                    orderLineId: "line_phase5b_kitchen",
                    menuItemId: burgerId,
                    station: "kitchen",
                    behavior: "prepared",
                    inventoryItemId: "inv_phase5b_shared",
                    quantity: 100,
                    unit: "g",
                }),
                lineAllocation({
                    allocationId: "allocation_phase5b_bar",
                    orderLineId: "line_phase5b_bar",
                    menuItemId: directDrinkId,
                    station: "bar",
                    behavior: "direct",
                    inventoryItemId: "inv_phase5b_shared",
                    quantity: 50,
                    unit: "g",
                }),
            ],
            menuItemIds: [burgerId, directDrinkId],
        })

        await Promise.all([
            transitionOrderFulfillment({
                businessId: "biz_phase5b_integration",
                orderId: "ord_phase5b_concurrent",
                station: "kitchen",
                action: "start",
                orderLineIds: ["line_phase5b_kitchen"],
                actor,
            }),
            transitionOrderFulfillment({
                businessId: "biz_phase5b_integration",
                orderId: "ord_phase5b_concurrent",
                station: "bar",
                action: "ready",
                orderLineIds: ["line_phase5b_bar"],
                actor,
            }),
        ])

        let storedOrder = await Order.findOne({ orderId: "ord_phase5b_concurrent" }).lean()
        let storedReservation = await InventoryReservation.findOne({
            reservationId: "irv_phase5b_concurrent",
        }).lean()
        let shared = await InventoryItem.findOne({
            inventoryItemId: "inv_phase5b_shared",
        }).lean()
        assert.equal(
            storedOrder.items.find((line) => line.orderLineId === "line_phase5b_kitchen")
                .fulfillmentStatus,
            "in_progress",
        )
        assert.equal(
            storedOrder.items.find((line) => line.orderLineId === "line_phase5b_bar")
                .fulfillmentStatus,
            "ready",
        )
        assert.deepEqual([shared.onHandQuantity, shared.reservedQuantity], [850, 0])
        assert.equal(shared.onHandQuantity - shared.reservedQuantity, 850)
        assert.ok(storedReservation.lineAllocations.every(
            (entry) => entry.status === INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED,
        ))
        assert.equal(await InventoryMovement.countDocuments({
            businessId: "biz_phase5b_integration",
            type: "CONSUME",
            sourceId: "irv_phase5b_concurrent",
        }), 2)

        // Duplicate actions and Prepared READY never create more consumption.
        await transitionOrderFulfillment({
            businessId: "biz_phase5b_integration",
            orderId: "ord_phase5b_concurrent",
            station: "kitchen",
            action: "start",
            orderLineIds: ["line_phase5b_kitchen"],
            actor,
        })
        await transitionOrderFulfillment({
            businessId: "biz_phase5b_integration",
            orderId: "ord_phase5b_concurrent",
            station: "bar",
            action: "ready",
            orderLineIds: ["line_phase5b_bar"],
            actor,
        })
        await transitionOrderFulfillment({
            businessId: "biz_phase5b_integration",
            orderId: "ord_phase5b_concurrent",
            station: "kitchen",
            action: "ready",
            orderLineIds: ["line_phase5b_kitchen"],
            actor,
        })
        assert.equal(await InventoryMovement.countDocuments({
            businessId: "biz_phase5b_integration",
            type: "CONSUME",
            sourceId: "irv_phase5b_concurrent",
        }), 2)

        // A multi-ingredient recipe rolls back both inventory and fulfilment if
        // any ledger write in the transaction fails.
        const atomicBurgerId = new mongoose.Types.ObjectId()
        await InventoryItem.create([
            {
                inventoryItemId: "inv_phase5b_atomic_beef",
                businessId: "biz_phase5b_integration",
                name: "Atomic beef",
                trackingUnit: "g",
                baseUnitDimension: "weight",
                onHandQuantity: 500,
                reservedQuantity: 100,
                lowStockThreshold: 0,
            },
            {
                inventoryItemId: "inv_phase5b_atomic_bun",
                businessId: "biz_phase5b_integration",
                name: "Atomic bun",
                trackingUnit: "piece",
                baseUnitDimension: "count",
                onHandQuantity: 10,
                reservedQuantity: 1,
                lowStockThreshold: 0,
            },
        ])
        await createCanonicalOrder({
            orderId: "ord_phase5b_atomic",
            reservationId: "irv_phase5b_atomic",
            items: [orderLine({
                orderLineId: "line_phase5b_atomic",
                menuItemId: atomicBurgerId,
                station: "kitchen",
                behavior: "prepared",
            })],
        })
        await createCommittedReservation({
            reservationId: "irv_phase5b_atomic",
            orderId: "ord_phase5b_atomic",
            components: [
                { inventoryItemId: "inv_phase5b_atomic_beef", canonicalQuantity: 100, unit: "g" },
                { inventoryItemId: "inv_phase5b_atomic_bun", canonicalQuantity: 1, unit: "piece" },
            ],
            lineAllocations: [
                lineAllocation({
                    allocationId: "allocation_phase5b_atomic_beef",
                    orderLineId: "line_phase5b_atomic",
                    menuItemId: atomicBurgerId,
                    station: "kitchen",
                    behavior: "prepared",
                    inventoryItemId: "inv_phase5b_atomic_beef",
                    quantity: 100,
                    unit: "g",
                }),
                lineAllocation({
                    allocationId: "allocation_phase5b_atomic_bun",
                    orderLineId: "line_phase5b_atomic",
                    menuItemId: atomicBurgerId,
                    station: "kitchen",
                    behavior: "prepared",
                    inventoryItemId: "inv_phase5b_atomic_bun",
                    quantity: 1,
                    unit: "piece",
                }),
            ],
            menuItemIds: [atomicBurgerId],
        })
        let movementWrites = 0
        await assert.rejects(
            transitionOrderFulfillment({
                businessId: "biz_phase5b_integration",
                orderId: "ord_phase5b_atomic",
                station: "kitchen",
                action: "start",
                actor,
            }, {
                inventoryDependencies: {
                    InventoryMovementModel: {
                        async create(documents, options) {
                            movementWrites += 1
                            if (movementWrites === 2) throw new Error("Injected ledger failure")
                            return InventoryMovement.create(documents, options)
                        },
                    },
                },
            }),
            /Injected ledger failure/,
        )
        storedOrder = await Order.findOne({ orderId: "ord_phase5b_atomic" }).lean()
        storedReservation = await InventoryReservation.findOne({
            reservationId: "irv_phase5b_atomic",
        }).lean()
        const atomicItemsAfterFailure = await InventoryItem.find({
            inventoryItemId: { $in: ["inv_phase5b_atomic_beef", "inv_phase5b_atomic_bun"] },
        }).sort({ inventoryItemId: 1 }).lean()
        assert.equal(storedOrder.status, "placed")
        assert.equal(storedOrder.items[0].fulfillmentStatus, "pending")
        assert.deepEqual(
            atomicItemsAfterFailure.map((item) => [item.onHandQuantity, item.reservedQuantity]),
            [[500, 100], [10, 1]],
        )
        assert.ok(storedReservation.lineAllocations.every(
            (entry) => entry.status === INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
        ))
        assert.equal(await InventoryMovement.countDocuments({
            sourceId: "irv_phase5b_atomic",
            type: "CONSUME",
        }), 0)

        await transitionOrderFulfillment({
            businessId: "biz_phase5b_integration",
            orderId: "ord_phase5b_atomic",
            station: "kitchen",
            action: "start",
            actor,
        })
        assert.equal(await InventoryMovement.countDocuments({
            sourceId: "irv_phase5b_atomic",
            type: "CONSUME",
        }), 2)

        // A legitimate pre-fulfilment cancellation and START race can commit
        // only one outcome: RELEASE or CONSUME, never both.
        const raceMenuItemId = new mongoose.Types.ObjectId()
        await InventoryItem.create({
            inventoryItemId: "inv_phase5b_release_race",
            businessId: "biz_phase5b_integration",
            name: "Release race stock",
            trackingUnit: "piece",
            baseUnitDimension: "count",
            onHandQuantity: 20,
            reservedQuantity: 2,
            lowStockThreshold: 0,
        })
        await createCanonicalOrder({
            orderId: "ord_phase5b_release_race",
            reservationId: "irv_phase5b_release_race",
            items: [orderLine({
                orderLineId: "line_phase5b_release_race",
                menuItemId: raceMenuItemId,
                station: "kitchen",
                behavior: "prepared",
                quantity: 2,
            })],
        })
        await createCommittedReservation({
            reservationId: "irv_phase5b_release_race",
            orderId: "ord_phase5b_release_race",
            components: [{
                inventoryItemId: "inv_phase5b_release_race",
                canonicalQuantity: 2,
                unit: "piece",
            }],
            lineAllocations: [lineAllocation({
                allocationId: "allocation_phase5b_release_race",
                orderLineId: "line_phase5b_release_race",
                menuItemId: raceMenuItemId,
                station: "kitchen",
                behavior: "prepared",
                inventoryItemId: "inv_phase5b_release_race",
                quantity: 2,
                unit: "piece",
            })],
            menuItemIds: [raceMenuItemId],
        })

        const cancellation = () => withCanonicalInventoryTransaction(async (session) => {
            const current = await Order.findOne({
                businessId: "biz_phase5b_integration",
                orderId: "ord_phase5b_release_race",
            }, null, { session })
            if (current.status !== "placed") throw new Error("Order already started")
            await releaseInventoryReservationWithinTransaction({
                businessId: current.businessId,
                reservationId: current.inventoryReservationId,
                releaseEvidence:
                    INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
                actor,
                session,
            })
            current.status = "cancelled"
            current.cancelledAt = new Date()
            await current.save({ session })
        })
        const race = await Promise.allSettled([
            transitionOrderFulfillment({
                businessId: "biz_phase5b_integration",
                orderId: "ord_phase5b_release_race",
                station: "kitchen",
                action: "start",
                actor,
            }),
            cancellation(),
        ])
        assert.equal(race.filter((result) => result.status === "fulfilled").length, 1)
        assert.equal(race.filter((result) => result.status === "rejected").length, 1)

        storedOrder = await Order.findOne({ orderId: "ord_phase5b_release_race" }).lean()
        storedReservation = await InventoryReservation.findOne({
            reservationId: "irv_phase5b_release_race",
        }).lean()
        shared = await InventoryItem.findOne({
            inventoryItemId: "inv_phase5b_release_race",
        }).lean()
        const raceMovements = await InventoryMovement.find({
            sourceId: "irv_phase5b_release_race",
        }).lean()
        assert.equal(shared.reservedQuantity, 0)
        assert.equal(raceMovements.length, 1)
        if (storedOrder.status === "cancelled") {
            assert.equal(shared.onHandQuantity, 20)
            assert.equal(storedReservation.lineAllocations[0].status, "released")
            assert.equal(raceMovements[0].type, "RELEASE")
        } else {
            assert.equal(storedOrder.status, "in_progress")
            assert.equal(shared.onHandQuantity, 18)
            assert.equal(storedReservation.lineAllocations[0].status, "consumed")
            assert.equal(raceMovements[0].type, "CONSUME")
        }
    } finally {
        await mongoose.connection.dropDatabase()
        await mongoose.disconnect()
    }
})
