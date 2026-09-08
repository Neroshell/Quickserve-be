import assert from "node:assert/strict"
import test from "node:test"

import { readOwnerOrdersPage } from "./src/services/ownerOrdersReadService.js"

function createOrderModel() {
    const calls = { find: null, aggregates: [] }
    return {
        calls,
        find(filter, projection) {
            calls.find = { filter, projection, sort: null, limit: null }
            return {
                sort(value) {
                    calls.find.sort = value
                    return this
                },
                limit(value) {
                    calls.find.limit = value
                    return this
                },
                async lean() {
                    return [{
                        _id: "507f1f77bcf86cd799439011",
                        orderId: "QS-080926-T20-155607-3362",
                        businessId: "biz_a",
                        displayLabel: "Table 20",
                        servicePointLabel: "sp_table_20",
                        orderType: "takeout",
                        paymentStatus: "paid",
                        status: "placed",
                        createdAt: new Date("2026-09-08T13:58:00.000Z"),
                        items: [],
                        total: 10.6,
                    }]
                },
            }
        },
        async aggregate(pipeline) {
            calls.aggregates.push(pipeline)
            if (calls.aggregates.length === 1) {
                return [
                    { _id: "placed", count: 1, totalOrderValue: 10.6 },
                    { _id: "completed", count: 2, totalOrderValue: 31.4 },
                ]
            }
            return [{
                _id: null,
                orderTypes: ["takeout", "dine-in", null],
                paymentStatuses: ["paid", "pending", "unknown"],
                servicePoints: [
                    { id: "sp_table_20", label: "Table 20" },
                    { id: "sp_bar", label: "Bar" },
                ],
            }]
        },
    }
}

test("owner order refinements remain tenant scoped and filter before pagination", async () => {
    const OrderModel = createOrderModel()
    await readOwnerOrdersPage({
        businessId: "biz_a",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-10-01T00:00:00.000Z"),
        status: "placed",
        search: "3362",
        orderType: "takeout",
        paymentStatus: "paid",
        servicePointId: "sp_table_20",
    }, { OrderModel })

    assert.equal(OrderModel.calls.find.filter.businessId, "biz_a")
    assert.equal(OrderModel.calls.find.filter.status, "placed")
    assert.equal(OrderModel.calls.find.filter.orderType, "takeout")
    assert.equal(OrderModel.calls.find.filter.paymentStatus, "paid")
    assert.equal(OrderModel.calls.find.filter.servicePointLabel, "sp_table_20")
    assert.deepEqual(
        OrderModel.calls.find.filter.$or.map((condition) => Object.keys(condition)[0]),
        ["orderId", "servicePointLabel", "displayLabel"],
    )
    assert.deepEqual(OrderModel.calls.find.sort, { createdAt: -1, _id: -1 })
    assert.equal(OrderModel.calls.find.limit, 26)
})

test("owner order summary and filter metadata cover the full selected period", async () => {
    const OrderModel = createOrderModel()
    const result = await readOwnerOrdersPage({
        businessId: "biz_a",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-10-01T00:00:00.000Z"),
    }, { OrderModel })

    assert.deepEqual(result.counts, {
        placed: 1,
        in_progress: 0,
        ready: 0,
        completed: 2,
    })
    assert.deepEqual(result.summary, { totalOrders: 3, totalOrderValue: 42 })
    assert.deepEqual(result.filterOptions.orderTypes, ["dine-in", "takeout"])
    assert.deepEqual(result.filterOptions.paymentStatuses, ["paid", "pending"])
    assert.deepEqual(result.filterOptions.servicePoints, [
        { id: "sp_bar", label: "Bar" },
        { id: "sp_table_20", label: "Table 20" },
    ])
    assert.equal(OrderModel.calls.aggregates[0][0].$match.businessId, "biz_a")
    assert.equal(OrderModel.calls.aggregates[1][0].$match.businessId, "biz_a")
})
