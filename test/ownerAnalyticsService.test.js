import assert from "node:assert/strict"
import test from "node:test"
import { createOwnerAnalyticsService } from "../src/services/analytics/ownerAnalyticsService.js"

test("owner analytics orchestration resolves the range and returns the current flat food-service DTO", async () => {
    const calls = []
    const resolvedRange = {
        preset: "7days",
        startDate: new Date("2026-07-22T00:00:00.000Z"),
        endDate: new Date("2026-07-29T00:00:00.000Z"),
        timezone: "UTC",
    }
    const legacyDto = {
        stats: { todayRevenue: 50 },
        revenueByDay: [],
        hourlyOrders: [],
        topItems: [],
        categoryPerformance: [],
        orderTypeBreakdown: [],
        channelBreakdown: [],
        serviceCalls: {},
        tablePerformance: [],
        waitstaffPerformance: [],
    }

    const service = createOwnerAnalyticsService({
        rangeResolver(input) {
            calls.push({ type: "range", input })
            return resolvedRange
        },
        async foodServiceAnalytics(input) {
            calls.push({ type: "food", input })
            return legacyDto
        },
    })

    const result = await service({
        businessId: "biz_1",
        range: "7days",
        from: "2026-07-22",
        to: "2026-07-28",
    })

    assert.equal(result, legacyDto)
    assert.deepEqual(calls, [
        {
            type: "range",
            input: {
                preset: "7days",
                from: "2026-07-22",
                to: "2026-07-28",
            },
        },
        {
            type: "food",
            input: {
                businessId: "biz_1",
                analyticsRange: resolvedRange,
            },
        },
    ])
    assert.equal("modules" in result, false)
})
