import assert from "node:assert/strict"
import test from "node:test"

import {
    OwnerInventoryReadError,
    readInventoryItem,
    readInventoryItemsPage,
    readInventoryMovementsPage,
    readInventoryOverview,
} from "../src/services/ownerInventoryReadService.js"

function queryReturning(rows, capture) {
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

const ITEM_A = {
    _id: "507f1f77bcf86cd799439011",
    inventoryItemId: "inv_a",
    businessId: "biz_alpha",
    name: "Apples",
    category: "Produce",
    trackingUnit: "piece",
    baseUnitDimension: "count",
    onHandQuantity: 20,
    reservedQuantity: 5,
    lowStockThreshold: 5,
    isActive: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
}

const ITEM_B = {
    ...ITEM_A,
    _id: "507f1f77bcf86cd799439012",
    inventoryItemId: "inv_b",
    name: "Bananas",
}

const MOVEMENT = {
    _id: "507f1f77bcf86cd799439013",
    movementId: "imv_a",
    businessId: "biz_alpha",
    inventoryItemId: "inv_a",
    type: "RECEIVE",
    quantityDeltaOnHand: 20,
    quantityDeltaReserved: 0,
    unit: "piece",
    canonicalQuantity: 20,
    onHandBefore: 0,
    onHandAfter: 20,
    reservedBefore: 0,
    reservedAfter: 0,
    sourceType: "manual_receive",
    sourceId: null,
    reasonCode: null,
    note: null,
    performedBy: { staffId: "owner", role: "owner", name: "Owner" },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
}

test("owner inventory item reads are tenant scoped, derived, and cursor paginated", async () => {
    const capture = {}
    const InventoryItemModel = {
        find(filter) {
            capture.filter = filter
            return queryReturning([ITEM_A, ITEM_B], capture)
        },
    }
    const page = await readInventoryItemsPage({
        businessId: "biz_alpha",
        active: "true",
        category: "Produce",
        search: "app",
        stockStatus: "low_stock",
        limit: 1,
    }, { InventoryItemModel })

    assert.equal(capture.filter.businessId, "biz_alpha")
    assert.equal(capture.filter.isActive, true)
    assert.equal(capture.limit, 2)
    assert.deepEqual(capture.sort, { name: 1, _id: 1 })
    assert.deepEqual(
        capture.filter.$and.find((condition) => condition.$expr),
        {
            $expr: {
                $and: [
                    { $gt: [{ $subtract: ["$onHandQuantity", "$reservedQuantity"] }, 0] },
                    { $lte: [{ $subtract: ["$onHandQuantity", "$reservedQuantity"] }, "$lowStockThreshold"] },
                ],
            },
        },
    )
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].availableQuantity, 15)
    assert.equal(page.items[0]._id, undefined)
    assert.equal(page.pagination.hasNextPage, true)
    assert.ok(page.pagination.nextCursor)

    await assert.rejects(
        readInventoryItemsPage({
            businessId: "biz_alpha",
            active: "true",
            category: "Different",
            search: "app",
            stockStatus: "low_stock",
            limit: 1,
            cursor: page.pagination.nextCursor,
        }, { InventoryItemModel }),
        (error) => error instanceof OwnerInventoryReadError && /does not match/.test(error.message),
    )

    await assert.rejects(
        readInventoryItemsPage({
            businessId: "biz_alpha",
            active: "true",
            category: "Produce",
            search: "app",
            stockStatus: "out_of_stock",
            limit: 1,
            cursor: page.pagination.nextCursor,
        }, { InventoryItemModel }),
        (error) => error instanceof OwnerInventoryReadError && /does not match/.test(error.message),
    )
})

test("owner inventory stock filters use canonical available quantity", async () => {
    const captures = []
    const InventoryItemModel = {
        find(filter) {
            const capture = { filter }
            captures.push(capture)
            return queryReturning([], capture)
        },
    }

    await readInventoryItemsPage({
        businessId: "biz_alpha",
        stockStatus: "out_of_stock",
    }, { InventoryItemModel })

    assert.deepEqual(captures[0].filter.$and, [{
        $expr: {
            $lte: [{ $subtract: ["$onHandQuantity", "$reservedQuantity"] }, 0],
        },
    }])

    await assert.rejects(
        readInventoryItemsPage({
            businessId: "biz_alpha",
            stockStatus: "almost_empty",
        }, { InventoryItemModel }),
        (error) => error instanceof OwnerInventoryReadError && /stockStatus/.test(error.message),
    )
})

test("single item lookup cannot return another tenant's inventory", async () => {
    const filters = []
    const InventoryItemModel = {
        findOne(filter) {
            filters.push(filter)
            return {
                async lean() {
                    return filter.businessId === "biz_alpha" ? ITEM_A : null
                },
            }
        },
    }
    const item = await readInventoryItem({
        businessId: "biz_alpha",
        inventoryItemId: "inv_a",
    }, { InventoryItemModel })
    assert.equal(item.inventoryItemId, "inv_a")
    assert.deepEqual(filters[0], { businessId: "biz_alpha", inventoryItemId: "inv_a" })

    await assert.rejects(
        readInventoryItem({
            businessId: "biz_other",
            inventoryItemId: "inv_a",
        }, { InventoryItemModel }),
        (error) => error.statusCode === 404,
    )
})

test("movement history applies tenant, item, type, date, and stable sorting", async () => {
    const capture = {}
    const InventoryMovementModel = {
        find(filter) {
            capture.filter = filter
            return queryReturning([MOVEMENT], capture)
        },
    }
    const page = await readInventoryMovementsPage({
        businessId: "biz_alpha",
        inventoryItemId: "inv_a",
        type: "RECEIVE",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-02T00:00:00.000Z",
        limit: 25,
    }, { InventoryMovementModel })

    assert.equal(capture.filter.businessId, "biz_alpha")
    assert.equal(capture.filter.inventoryItemId, "inv_a")
    assert.equal(capture.filter.type, "RECEIVE")
    assert.deepEqual(capture.sort, { createdAt: -1, _id: -1 })
    assert.equal(page.movements[0].availableBefore, 0)
    assert.equal(page.movements[0].availableAfter, 20)
    assert.equal(page.movements[0]._id, undefined)
    assert.equal(page.movements[0].idempotencyKey, undefined)
})

test("inventory overview returns derived counts and recent immutable movements", async () => {
    let aggregatePipeline = null
    const movementCapture = {}
    const InventoryItemModel = {
        async aggregate(pipeline) {
            aggregatePipeline = pipeline
            return [{ activeItems: 5, lowStockItems: 2, outOfStockItems: 1 }]
        },
    }
    const InventoryMovementModel = {
        find(filter) {
            movementCapture.filter = filter
            return queryReturning([MOVEMENT], movementCapture)
        },
    }
    const overview = await readInventoryOverview({ businessId: "biz_alpha" }, {
        InventoryItemModel,
        InventoryMovementModel,
    })

    assert.deepEqual(aggregatePipeline[0], {
        $match: { businessId: "biz_alpha", isActive: true, deletedAt: null },
    })
    assert.deepEqual(movementCapture.filter, { businessId: "biz_alpha" })
    assert.equal(movementCapture.limit, 10)
    assert.deepEqual(overview.summary, {
        activeItems: 5,
        lowStockItems: 2,
        outOfStockItems: 1,
    })
    assert.equal(overview.recentMovements.length, 1)
})
