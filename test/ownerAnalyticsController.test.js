import assert from "node:assert/strict"
import test from "node:test"
import { AnalyticsRangeError } from "../src/services/analytics/analyticsRangeService.js"
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
    const dto = { stats: {}, revenueByDay: [] }
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
