import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"
import { ownerOrders } from "../src/controllers/ownerController.js"
import {
    decodeOwnerOrdersCursor,
    encodeOwnerOrdersCursor,
    readOwnerOrdersPage,
} from "../src/services/ownerOrdersReadService.js"

const START = new Date("2026-08-01T00:00:00.000Z")
const END = new Date("2026-09-01T00:00:00.000Z")
const STATUSES = ["placed", "in_progress", "ready", "completed"]

function objectId(number) {
    return new mongoose.Types.ObjectId(number.toString(16).padStart(24, "0"))
}

function comparable(value) {
    if (value instanceof Date) return value.getTime()
    if (value instanceof mongoose.Types.ObjectId) return value.toString()
    return value
}

function matchesCondition(actual, expected) {
    if (
        expected &&
        typeof expected === "object" &&
        !(expected instanceof Date) &&
        !(expected instanceof mongoose.Types.ObjectId) &&
        !(expected instanceof RegExp)
    ) {
        return Object.entries(expected).every(([operator, operand]) => {
            if (operator === "$regex") return operand.test(String(actual ?? ""))
            if (operator === "$in") {
                return operand.some((value) => comparable(actual) === comparable(value))
            }
            if (operator === "$ne") return comparable(actual) !== comparable(operand)
            if (operator === "$gte") return comparable(actual) >= comparable(operand)
            if (operator === "$gt") return comparable(actual) > comparable(operand)
            if (operator === "$lt") return comparable(actual) < comparable(operand)
            throw new Error(`Unsupported fake query operator: ${operator}`)
        })
    }

    return comparable(actual) === comparable(expected)
}

function matchesFilter(document, filter) {
    return Object.entries(filter).every(([field, condition]) => {
        if (field === "$and") {
            return condition.every((clause) => matchesFilter(document, clause))
        }
        if (field === "$or") {
            return condition.some((clause) => matchesFilter(document, clause))
        }
        return matchesCondition(document[field], condition)
    })
}

function compareDocuments(left, right, sort) {
    for (const [field, direction] of Object.entries(sort)) {
        const leftValue = comparable(left[field])
        const rightValue = comparable(right[field])
        if (leftValue < rightValue) return -1 * direction
        if (leftValue > rightValue) return 1 * direction
    }
    return 0
}

function createOrderModel(documents) {
    const calls = { find: [], aggregate: [] }

    return {
        calls,
        find(filter, projection) {
            const call = { filter, projection, sort: null, limit: null }
            calls.find.push(call)

            return {
                sort(sort) {
                    call.sort = sort
                    return this
                },
                limit(limit) {
                    call.limit = limit
                    return this
                },
                async lean() {
                    return documents
                        .filter((document) => matchesFilter(document, filter))
                        .sort((left, right) => compareDocuments(left, right, call.sort))
                        .slice(0, call.limit)
                },
            }
        },
        async aggregate(pipeline) {
            calls.aggregate.push(pipeline)
            const matched = documents.filter((document) => (
                matchesFilter(document, pipeline[0].$match)
            ))
            const counts = new Map()
            for (const document of matched) {
                counts.set(document.status, (counts.get(document.status) || 0) + 1)
            }
            return Array.from(counts, ([_id, count]) => ({ _id, count }))
        },
    }
}

function createOrders(count = 60, businessId = "biz_a") {
    return Array.from({ length: count }, (_, index) => {
        const number = index + 1
        const sharedTimestampGroup = Math.floor(index / 3)
        return {
            _id: objectId(number),
            businessId,
            orderId: `ORD-${String(number).padStart(3, "0")}`,
            servicePointLabel: `Table ${(number % 8) + 1}`,
            displayLabel: `Table ${(number % 8) + 1}`,
            status: STATUSES[index % STATUSES.length],
            createdAt: new Date(`2026-08-${String(28 - sharedTimestampGroup).padStart(2, "0")}T12:00:00.000Z`),
            items: [],
            total: number,
            paymentStatus: "paid",
        }
    })
}

async function readPage(documents, overrides = {}) {
    const OrderModel = createOrderModel(documents)
    const result = await readOwnerOrdersPage({
        businessId: "biz_a",
        startDate: START,
        endDate: END,
        status: "all",
        search: "",
        ...overrides,
    }, { OrderModel })
    return { result, OrderModel }
}

function ids(result) {
    return result.rawOrders.map((order) => order.orderId)
}

test("owner orders defaults to at most 25 records and caps oversized limits", async () => {
    const documents = createOrders()
    const defaultPage = await readPage(documents)
    const oversizedPage = await readPage(documents, { limit: "1000" })

    assert.equal(defaultPage.result.rawOrders.length, 25)
    assert.equal(defaultPage.result.pagination.limit, 25)
    assert.equal(defaultPage.OrderModel.calls.find[0].limit, 26)
    assert.equal(oversizedPage.result.rawOrders.length, 25)
    assert.equal(oversizedPage.result.pagination.limit, 25)
})

test("owner orders use createdAt DESC and _id DESC as a deterministic tuple", async () => {
    const { result, OrderModel } = await readPage(createOrders(12), { limit: 12 })

    assert.deepEqual(OrderModel.calls.find[0].sort, { createdAt: -1, _id: -1 })
    assert.deepEqual(ids(result).slice(0, 3), ["ORD-003", "ORD-002", "ORD-001"])
})

test("nextCursor returns the next distinct set", async () => {
    const documents = createOrders()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result

    assert.equal(second.rawOrders.length, 25)
    assert.notDeepEqual(ids(second), ids(first))
})

test("adjacent owner-order pages contain no duplicates", async () => {
    const documents = createOrders()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result
    const firstIds = new Set(ids(first))

    assert.equal(ids(second).some((id) => firstIds.has(id)), false)
})

test("cursor traversal skips no orders when multiple records share createdAt", async () => {
    const documents = createOrders(60)
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, { cursor, direction: "next" })).result
        seen.push(...ids(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    const expected = [...documents]
        .sort((left, right) => compareDocuments(left, right, { createdAt: -1, _id: -1 }))
        .map((order) => order.orderId)

    assert.deepEqual(seen, expected)
})

test("previous navigation returns the correct preceding set", async () => {
    const documents = createOrders()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result
    const previous = (await readPage(documents, {
        cursor: second.pagination.previousCursor,
        direction: "previous",
    })).result

    assert.deepEqual(ids(previous), ids(first))
    assert.equal(previous.pagination.hasPreviousPage, false)
    assert.equal(previous.pagination.hasNextPage, true)
})

test("owner-order reads remain isolated to the authenticated businessId", async () => {
    const documents = [
        ...createOrders(10, "biz_a"),
        ...createOrders(10, "biz_b").map((order, index) => ({
            ...order,
            _id: objectId(index + 100),
            orderId: `OTHER-${index}`,
        })),
    ]
    const { result, OrderModel } = await readPage(documents)

    assert.equal(result.rawOrders.every((order) => order.businessId === "biz_a"), true)
    assert.equal(OrderModel.calls.find[0].filter.businessId, "biz_a")
    assert.equal(OrderModel.calls.aggregate[0][0].$match.businessId, "biz_a")
})

test("status filtering applies before cursor pagination", async () => {
    const { result } = await readPage(createOrders(), { status: "ready" })

    assert.equal(result.rawOrders.every((order) => order.status === "ready"), true)
    assert.equal(result.rawOrders.length, 15)
})

test("date-range filtering applies before cursor pagination", async () => {
    const documents = createOrders(12)
    documents.push({
        ...documents[0],
        _id: objectId(500),
        orderId: "OUTSIDE-RANGE",
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
    })
    const { result } = await readPage(documents)

    assert.equal(ids(result).includes("OUTSIDE-RANGE"), false)
})

test("orderId and displayLabel search work with cursor pagination", async () => {
    const documents = createOrders(40).map((order, index) => ({
        ...order,
        displayLabel: index % 2 === 0 ? "Garden Booth" : order.displayLabel,
    }))
    const byOrderId = (await readPage(documents, { search: "ord-007" })).result
    const byServicePoint = (await readPage(documents, { search: "garden booth" })).result

    assert.deepEqual(ids(byOrderId), ["ORD-007"])
    assert.equal(byServicePoint.rawOrders.length, 20)
})

test("malformed owner-order cursors are rejected as clean client errors", async () => {
    assert.throws(
        () => decodeOwnerOrdersCursor("not-a-valid-cursor"),
        (error) => error.name === "OwnerOrdersCursorError" && error.statusCode === 400,
    )

    const response = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
    await ownerOrders({
        session: { user: { businessId: "biz_a" } },
        query: { cursor: "not-a-valid-cursor" },
    }, response)

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.body, { error: "Invalid owner orders cursor" })

    const staleCursor = encodeOwnerOrdersCursor({
        _id: objectId(900),
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
    })
    await assert.rejects(
        () => readPage(createOrders(), { cursor: staleCursor }),
        (error) => error.name === "OwnerOrdersCursorError" && error.statusCode === 400,
    )
})

test("status counts cover the full selected range rather than the current page", async () => {
    const { result } = await readPage(createOrders(60), { status: "placed" })

    assert.equal(result.rawOrders.length, 15)
    assert.deepEqual(result.counts, {
        placed: 15,
        in_progress: 15,
        ready: 15,
        completed: 15,
    })
    assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), 60)
})
