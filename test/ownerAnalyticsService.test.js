import assert from "node:assert/strict"
import test from "node:test"
import {
    OwnerAnalyticsServiceError,
    createOwnerAnalyticsService,
} from "../src/services/analytics/ownerAnalyticsService.js"
import { normalizeBusinessHealth } from "../src/services/ai/businessHealthNormalizer.js"
import { generateWeeklySnapshot } from "../src/services/analytics/weeklyAnalystSnapshotService.js"

const fixedGeneratedAt = new Date(
    "2026-07-28T12:00:00.000Z"
)
const foodOperationalRange = {
    preset: "today",
    timezone: "Europe/Berlin",
    from: "2026-07-28",
    to: "2026-07-28",
    startUtc: new Date("2026-07-28T00:00:00.000Z"),
    endUtcExclusive: new Date(
        "2026-07-29T00:00:00.000Z"
    ),
    comparison: {
        from: "2026-07-27",
        to: "2026-07-27",
        startUtc: new Date(
            "2026-07-27T00:00:00.000Z"
        ),
        endUtcExclusive: new Date(
            "2026-07-28T00:00:00.000Z"
        ),
    },
}
const lodgingCalendarRange = {
    ...foodOperationalRange,
    startUtc: new Date("2026-07-27T22:00:00.000Z"),
    endUtcExclusive: new Date(
        "2026-07-28T22:00:00.000Z"
    ),
}
const domainRanges = {
    foodOperationalRange,
    lodgingCalendarRange,
}
const rangeContract = {
    preset: "today",
    timezone: "Europe/Berlin",
    foodOperationalRange: {
        from: "2026-07-28",
    },
    lodgingCalendarRange: {
        from: "2026-07-28",
    },
}
const shared = {
    paidRevenue: {
        grossCents: 35000,
        netToBusinessCents: null,
        transactionCount: 3,
        averageTransactionValueCents: 11667,
        comparisonPercent: 25,
    },
    revenueByDay: [],
    revenueByModule: [],
}
const foodFinancials = {
    current: { grossCents: 5000 },
}
const lodgingFinancials = {
    current: { grossCents: 30000 },
}
const foodModule = {
    overview: { activeOrders: 1 },
}
const lodgingModule = {
    overview: { scheduledArrivals: 2 },
}

function createBusinessModel(business, calls) {
    return {
        findOne(filter, projection) {
            calls.push({
                type: "business",
                filter,
                projection,
            })
            return {
                lean: async () => business,
            }
        },
    }
}

function createService(business) {
    const calls = []
    const service = createOwnerAnalyticsService({
        businessModel: createBusinessModel(
            business,
            calls
        ),
        rangeResolver(input) {
            calls.push({ type: "range", input })
            return domainRanges
        },
        rangeContractSerializer(input) {
            assert.equal(input, domainRanges)
            return rangeContract
        },
        async sharedAnalytics(input) {
            calls.push({ type: "shared", input })
            return {
                shared,
                foodServiceFinancials: foodFinancials,
                lodgingFinancials,
            }
        },
        async foodServiceAnalytics(input) {
            calls.push({ type: "food", input })
            return foodModule
        },
        async lodgingAnalytics(input) {
            calls.push({ type: "lodging", input })
            return lodgingModule
        },
        clock: () => fixedGeneratedAt,
    })
    return { service, calls }
}

test("owner analytics service derives non-UTC domain ranges from the loaded Business", async (t) => {
    async function resolveFor({ business, now, range = "today", from, to }) {
        const service = createOwnerAnalyticsService({
            businessModel: createBusinessModel(business, []),
            capabilityResolver: () => ({ analytics: { sections: [] } }),
            clock: () => now,
        })
        return service({
            businessId: business.businessId,
            range,
            from,
            to,
        })
    }

    await t.test("Europe/Malta today keeps food operational and lodging calendar days distinct", async () => {
        const result = await resolveFor({
            business: {
                businessId: "biz_malta_endpoint",
                businessType: "restaurant",
                modules: [],
                timezone: "Europe/Malta",
                currency: "EUR",
                operatingHours: {
                    Tuesday: { openTime: "09:00", closeTime: "02:00" },
                    Wednesday: { openTime: "09:00", closeTime: "23:00" },
                },
            },
            now: new Date("2026-09-15T22:30:00.000Z"),
        })
        assert.equal(result.range.timezone, "Europe/Malta")
        assert.equal(result.range.foodOperationalRange.from, "2026-09-15")
        assert.equal(result.range.lodgingCalendarRange.from, "2026-09-16")
    })

    await t.test("America/New_York 7days retains the tenant timezone", async () => {
        const result = await resolveFor({
            business: {
                businessId: "biz_ny_endpoint",
                businessType: "restaurant",
                modules: [],
                timezone: "America/New_York",
                currency: "USD",
                operatingHours: {
                    Monday: { openTime: "09:00", closeTime: "02:00" },
                    Tuesday: { openTime: "09:00", closeTime: "22:00" },
                },
            },
            now: new Date("2026-07-28T05:30:00.000Z"),
            range: "7days",
        })
        assert.equal(result.range.timezone, "America/New_York")
        assert.equal(result.range.foodOperationalRange.from, "2026-07-21")
        assert.equal(result.range.foodOperationalRange.to, "2026-07-27")
        assert.equal(result.range.lodgingCalendarRange.from, "2026-07-22")
        assert.equal(result.range.lodgingCalendarRange.to, "2026-07-28")
    })

    await t.test("America/New_York custom lodging day spans the DST fall-back", async () => {
        const result = await resolveFor({
            business: {
                businessId: "biz_ny_dst_endpoint",
                businessType: "hotel",
                modules: [],
                timezone: "America/New_York",
                currency: "USD",
            },
            now: fixedGeneratedAt,
            range: "custom",
            from: "2026-11-01",
            to: "2026-11-01",
        })
        assert.equal(
            result.range.lodgingCalendarRange.startUtc,
            "2026-11-01T04:00:00.000Z",
        )
        assert.equal(
            result.range.lodgingCalendarRange.endUtcExclusive,
            "2026-11-02T05:00:00.000Z",
        )
    })
})

for (const businessType of [
    "restaurant",
    "bar_lounge",
]) {
    test(`${businessType} executes only foodService under the server-resolved v2 contract`, async () => {
        const business = {
            businessId: `biz_${businessType}`,
            businessType,
            modules: ["foodService"],
            timezone: "Europe/Berlin",
            currency: "usd",
        }
        const { service, calls } =
            createService(business)
        const result = await service({
            businessId: business.businessId,
            range: "today",
        })

        assert.deepEqual(result, {
            contractVersion: 2,
            range: rangeContract,
            currency: "USD",
            generatedAt:
                fixedGeneratedAt.toISOString(),
            enabledAnalyticsModules: ["foodService"],
            shared,
            modules: {
                foodService: foodModule,
            },
        })
        assert.deepEqual(calls[0].filter, {
            businessId: business.businessId,
        })
        assert.deepEqual(calls[1], {
            type: "range",
            input: {
                preset: "today",
                from: undefined,
                to: undefined,
                now: fixedGeneratedAt,
                business,
            },
        })
        assert.match(calls[0].projection, /operatingHours/)
        assert.equal(
            calls.filter(
                (call) => call.type === "food"
            ).length,
            1
        )
        assert.equal(
            calls.some(
                (call) => call.type === "lodging"
            ),
            false
        )
    })
}

test("hybrid hotel executes lodging and foodService and returns both modules once", async () => {
    const { service, calls } = createService({
        businessId: "biz_hybrid",
        businessType: "hotel",
        modules: ["lodging", "foodService"],
        timezone: "Europe/Berlin",
        currency: "EUR",
    })

    const result = await service({
        businessId: "biz_hybrid",
    })

    assert.deepEqual(result.enabledAnalyticsModules, [
        "lodging",
        "foodService",
    ])
    assert.deepEqual(result.modules, {
        lodging: lodgingModule,
        foodService: foodModule,
    })
    assert.equal(
        calls.filter(
            (call) => call.type === "shared"
        ).length,
        1
    )
    assert.equal(
        calls.some((call) => call.type === "food"),
        true
    )
    assert.equal(
        calls.some(
            (call) => call.type === "lodging"
        ),
        true
    )
    const sharedCall = calls.find(
        (call) => call.type === "shared"
    )
    assert.deepEqual(
        sharedCall.input.enabledAnalyticsModules,
        ["lodging", "foodService"]
    )
})

test("lodging-only hotel returns shared and lodging data without executing foodService", async () => {
    const { service, calls } = createService({
        businessId: "biz_lodging",
        businessType: "hotel",
        modules: ["lodging"],
        timezone: "Europe/Paris",
        currency: "GBP",
        hotelSettings: {
            checkInTime: "16:00",
            checkOutTime: "10:30",
        },
    })

    const result = await service({
        businessId: "biz_lodging",
        // Ignored: execution comes only from persisted server
        // capabilities, never a client-requested module list.
        modules: ["foodService"],
    })

    assert.deepEqual(result, {
        contractVersion: 2,
        range: rangeContract,
        currency: "GBP",
        generatedAt:
            fixedGeneratedAt.toISOString(),
        enabledAnalyticsModules: ["lodging"],
        shared,
        modules: {
            lodging: lodgingModule,
        },
    })
    assert.equal(
        calls.some((call) => call.type === "food"),
        false
    )
    const lodgingCall = calls.find(
        (call) => call.type === "lodging"
    )
    assert.equal(
        lodgingCall.input.analyticsRange,
        lodgingCalendarRange
    )
    assert.equal(
        lodgingCall.input.generatedAt,
        fixedGeneratedAt
    )
    assert.deepEqual(lodgingCall.input.hotelSettings, {
        checkInTime: "16:00",
        checkOutTime: "10:30",
    })
})

test("missing business produces a typed service error", async () => {
    const service = createOwnerAnalyticsService({
        businessModel: {
            findOne() {
                return { lean: async () => null }
            },
        },
    })

    await assert.rejects(
        () => service({ businessId: "missing" }),
        (error) =>
            error instanceof OwnerAnalyticsServiceError &&
            error.statusCode === 404
    )
})

test("business health never reports Healthy without positive supporting evidence", () => {
    const normalized = normalizeBusinessHealth(
        {
            businessHealth: [
                { area: "Sales", status: "Healthy", explanation: "Generated copy" },
                { area: "Customer feedback", status: "Healthy", explanation: "Generated copy" },
                { area: "Kitchen speed", status: "Healthy", explanation: "Generated copy" },
                { area: "Repeat customers", status: "Healthy", explanation: "Generated copy" },
            ],
        },
        {
            insufficientData: false,
            insights: [
                { category: "revenue", type: "positive", priority: "high", impact: "high" },
                { category: "operations", type: "warning", priority: "high", impact: "high" },
            ],
        },
        {
            sales: { transactionCount: 12 },
            operations: { completedOrders: 12 },
            feedback: { reviewCount: 0 },
            customers: {
                distinctVisitors: 12,
                returningCustomersChangePercent: -20,
            },
        },
    )

    assert.deepEqual(
        normalized.businessHealth.map((entry) => entry.status),
        ["Healthy", "Insufficient data", "Strained", "Watch"],
    )
})

test("overall insufficient evidence overrides generated health labels", () => {
    const normalized = normalizeBusinessHealth(
        { businessHealth: [{ area: "Sales", status: "Healthy", explanation: "Generated copy" }] },
        { insufficientData: true, insights: [] },
        { sales: { transactionCount: 0 } },
    )

    assert.equal(normalized.businessHealth[0].status, "Insufficient data")
})

test("weekly analyst snapshot binds feedback evidence to the requested period", async () => {
    const feedbackPipelines = []
    let requestedFoodRange = null
    let requestedInventoryInput = null
    const inventory = {
        stockHealthAsOf: {
            asOf: "2026-08-17T12:00:00.000Z",
            periodAligned: false,
        },
        current: {
            totalMovementCount: 0,
            countsByType: {},
            ingredientShortages: {
                eventCount: 0,
                affectedItemCount: 0,
            },
        },
        previous: {
            totalMovementCount: 0,
            countsByType: {},
            ingredientShortages: {
                eventCount: 0,
                affectedItemCount: 0,
            },
        },
        comparison: {},
        tracking: {
            asOf: "2026-08-17T12:00:00.000Z",
            periodAligned: false,
        },
    }
    const snapshot = await generateWeeklySnapshot({
        businessId: "biz_feedback",
        periodStart: "2026-08-10",
        periodEnd: "2026-08-16",
        now: new Date("2026-08-17T12:00:00.000Z"),
        businessModel: {
            findOne: () => ({
                lean: async () => ({
                    businessId: "biz_feedback",
                    businessType: "restaurant",
                    modules: [],
                    timezone: "Europe/Malta",
                    currency: "EUR",
                    operatingHours: {},
                }),
            }),
        },
        guestVisitModel: {
            distinct: async () => [],
            aggregate: async () => [{}],
        },
        guestProfileModel: {
            countDocuments: async () => 0,
        },
        feedbackModel: {
            aggregate: async (pipeline) => {
                feedbackPipelines.push(pipeline)
                return []
            },
        },
        sharedAnalytics: async ({ foodOperationalRange }) => {
            requestedFoodRange = foodOperationalRange
            return {
                shared: {
                    paidRevenue: {
                        grossCents: 0,
                        refundedCents: 0,
                        netRetainedCents: 0,
                        netToBusinessCents: 0,
                        transactionCount: 0,
                        averageTransactionValueCents: 0,
                    },
                    revenueByDay: [],
                },
            }
        },
        inventoryAnalystSummary: async (input) => {
            requestedInventoryInput = input
            return inventory
        },
    })

    assert.equal(snapshot.feedback.current.reviewCount, 0)
    assert.equal(snapshot.feedback.current.averageRating, null)
    assert.equal(snapshot.feedback.current.csatPercent, null)
    assert.deepEqual(snapshot.feedback.current.orderTypeBreakdown, [])
    assert.equal(snapshot.feedback.previous.reviewCount, 0)
    assert.equal(snapshot.feedback.comparison.reviewCountDelta, 0)
    assert.equal(feedbackPipelines.length, 3)
    assert.deepEqual(snapshot.inventory, inventory)
    assert.equal(requestedInventoryInput.businessId, "biz_feedback")
    assert.equal(requestedInventoryInput.analyticsRange, requestedFoodRange)
    assert.equal(requestedInventoryInput.periodAligned, false)
    assert.equal(
        requestedInventoryInput.asOf.toISOString(),
        "2026-08-17T12:00:00.000Z",
    )
    assert.deepEqual(feedbackPipelines[0][0].$match, {
        businessId: "biz_feedback",
        createdAt: {
            $gte: requestedFoodRange.startUtc,
            $lt: requestedFoodRange.endUtcExclusive,
        },
    })
    assert.deepEqual(feedbackPipelines[1][0].$match, {
        businessId: "biz_feedback",
        createdAt: {
            $gte: requestedFoodRange.comparison.startUtc,
            $lt: requestedFoodRange.comparison.endUtcExclusive,
        },
    })
    assert.deepEqual(feedbackPipelines[2][0].$match, {
        businessId: "biz_feedback",
        createdAt: {
            $gte: requestedFoodRange.startUtc,
            $lt: requestedFoodRange.endUtcExclusive,
        },
        orderType: { $in: ["dine-in", "takeout", "delivery"] },
    })
})
