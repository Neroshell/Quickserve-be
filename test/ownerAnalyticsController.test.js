import assert from "node:assert/strict"
import test from "node:test"
import { AnalyticsRangeError } from "../src/services/analytics/analyticsRangeService.js"
import { OwnerAnalyticsServiceError } from "../src/services/analytics/ownerAnalyticsService.js"
import { createOwnerAnalyticsController } from "../src/controllers/ownerAnalyticsController.js"

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

test("owner analytics controller passes only the authenticated tenant and range request to its service", async () => {
    const calls = []
    const dto = {
        contractVersion: 2,
        enabledAnalyticsModules: ["foodService"],
        modules: { foodService: {} },
    }
    const controller = createOwnerAnalyticsController({
        async getAnalytics(input) {
            calls.push(input)
            return dto
        },
    })
    const response = createResponse()

    await controller(
        {
            session: {
                user: {
                    businessId: "biz_session",
                },
            },
            query: {
                businessId: "biz_untrusted",
                range: "custom",
                from: "2026-07-01",
                to: "2026-07-02",
            },
        },
        response
    )

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, dto)
    assert.deepEqual(calls, [
        {
            businessId: "biz_session",
            range: "custom",
            from: "2026-07-01",
            to: "2026-07-02",
        },
    ])
})

test("owner analytics controller returns a lodging-only v2 response unchanged", async () => {
    const dto = {
        contractVersion: 2,
        enabledAnalyticsModules: ["lodging"],
        shared: {
            paidRevenue: {
                grossCents: 25000,
                transactionCount: 1,
            },
        },
        modules: {
            lodging: {
                overview: {
                    paidBookingRevenueCents: 25000,
                    paidBookingCount: 1,
                },
            },
        },
    }
    const controller = createOwnerAnalyticsController({
        async getAnalytics() {
            return dto
        },
    })
    const response = createResponse()

    await controller(
        {
            session: { user: { businessId: "hotel_1" } },
            query: {},
        },
        response
    )

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, dto)
    assert.equal("foodService" in response.body.modules, false)
})

test("owner analytics controller returns a hybrid v2 response unchanged", async () => {
    const dto = {
        contractVersion: 2,
        enabledAnalyticsModules: ["lodging", "foodService"],
        modules: {
            lodging: { overview: {} },
            foodService: { overview: {} },
        },
    }
    const controller = createOwnerAnalyticsController({
        async getAnalytics() {
            return dto
        },
    })
    const response = createResponse()

    await controller(
        {
            session: { user: { businessId: "hybrid_1" } },
            query: {
                modules: "foodService",
            },
        },
        response
    )

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, dto)
    assert.deepEqual(response.body.enabledAnalyticsModules, [
        "lodging",
        "foodService",
    ])
})

test("owner analytics controller rejects missing authenticated business context", async () => {
    const controller = createOwnerAnalyticsController({
        async getAnalytics() {
            throw new Error("must not be called")
        },
    })
    const response = createResponse()

    await controller({ session: {}, query: {} }, response)

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.body, {
        error: "businessId is required",
    })
})

test("owner analytics controller preserves range validation errors", async () => {
    const controller = createOwnerAnalyticsController({
        async getAnalytics() {
            throw new AnalyticsRangeError(
                "Missing 'from' or 'to' for custom range"
            )
        },
    })
    const response = createResponse()

    await controller(
        {
            session: { user: { businessId: "biz_1" } },
            query: { range: "custom" },
        },
        response
    )

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.body, {
        error: "Missing 'from' or 'to' for custom range",
    })
})

test("owner analytics controller preserves typed service errors", async () => {
    const controller = createOwnerAnalyticsController({
        async getAnalytics() {
            throw new OwnerAnalyticsServiceError(
                "Business not found",
                404
            )
        },
    })
    const response = createResponse()

    await controller(
        {
            session: {
                user: {
                    businessId: "biz_missing",
                },
            },
            query: {},
        },
        response
    )

    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.body, {
        error: "Business not found",
    })
})
