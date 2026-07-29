import assert from "node:assert/strict"
import test from "node:test"
import {
    OwnerAnalyticsServiceError,
    createOwnerAnalyticsService,
} from "../src/services/analytics/ownerAnalyticsService.js"

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
                timezone: "Europe/Berlin",
                now: fixedGeneratedAt,
            },
        })
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
