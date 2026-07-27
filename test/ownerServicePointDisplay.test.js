import assert from "node:assert/strict"
import test from "node:test"
import Order from "../src/models/order.js"
import Reservation from "../src/models/Reservation.js"
import ServicePoint from "../src/models/ServicePoint.js"
import {
    ownerOrders,
    ownerTransactions,
} from "../src/controllers/ownerController.js"

function createResponse() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
}

test("owner orders expose the persisted display label and preserve the internal ID", async (t) => {
    let servicePointLookups = 0

    t.mock.method(Order, "find", () => ({
        sort() {
            return this
        },
        lean: async () => [{
            orderId: "ORDER-123",
            servicePointLabel: "sp_2a357e40",
            displayLabel: "Table 20",
            orderType: "dine-in",
            status: "placed",
            items: [],
            total: 10,
            currency: "EUR",
        }],
    }))
    t.mock.method(Order, "aggregate", async () => [])
    t.mock.method(ServicePoint, "find", () => {
        servicePointLookups += 1
        throw new Error("owner orders must not query ServicePoint for display labels")
    })

    const res = createResponse()
    await ownerOrders(
        {
            query: { range: "today" },
            session: { user: { businessId: "business-123" } },
        },
        res,
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.orders[0].servicePointId, "sp_2a357e40")
    assert.equal(res.body.orders[0].servicePointLabel, "Table 20")
    assert.equal(servicePointLookups, 0)
})

test("owner transactions reshape orders without changing reservation labels or querying ServicePoint", async (t) => {
    let servicePointLookups = 0

    t.mock.method(Order, "find", () => ({
        lean: async () => [{
            orderId: "ORDER-123",
            servicePointLabel: "sp_2a357e40",
            displayLabel: "Table 20",
            status: "completed",
            createdAt: new Date("2026-07-27T10:00:00.000Z"),
        }],
    }))
    t.mock.method(Reservation, "find", () => ({
        lean: async () => [{
            _id: "reservation12345678",
            publicReference: "BOOKING-123",
            servicePointId: "sp_suite_101",
            servicePointLabel: "Suite 101",
            totalPrice: 100,
            status: "confirmed",
            createdAt: new Date("2026-07-27T09:00:00.000Z"),
        }],
    }))
    t.mock.method(ServicePoint, "find", () => {
        servicePointLookups += 1
        throw new Error("owner transactions must not query ServicePoint for display labels")
    })

    const res = createResponse()
    await ownerTransactions(
        {
            query: { range: "today" },
            session: { user: { businessId: "business-123" } },
        },
        res,
    )

    assert.equal(res.statusCode, 200)
    const order = res.body.transactions.find(
        (transaction) => transaction.sourceType === "order",
    )
    const reservation = res.body.transactions.find(
        (transaction) => transaction.sourceType === "reservation",
    )
    assert.equal(order.servicePointId, "sp_2a357e40")
    assert.equal(order.servicePointLabel, "Table 20")
    assert.equal(reservation.servicePointLabel, "Suite 101")
    assert.equal(servicePointLookups, 0)
})
