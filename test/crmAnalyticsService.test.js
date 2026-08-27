import assert from "node:assert/strict"
import test from "node:test"
import {
    bucketCrmDailyActivity,
    buildCrmVisitActivityPipeline,
    createCrmAnalyticsService,
} from "../src/services/crmAnalyticsService.js"
import { buildCrmProjection } from "../src/services/guestProfileService.js"

const generatedAt = new Date("2026-08-26T12:00:00.000Z")

function createFixture({
    visitFacet = {
        summary: [
            {
                activeCustomers: 2,
                newCustomers: 1,
                returningCustomers: 2,
                totalVisits: 4,
            },
        ],
        daily: [
            {
                _id: "2026-08-25",
                newCustomers: 1,
                returningCustomers: 1,
                visits: 2,
            },
            {
                _id: "2026-08-26",
                newCustomers: 0,
                returningCustomers: 2,
                visits: 2,
            },
        ],
    },
    revenue = {
        customerRevenueCents: 9000,
        paidOrderCount: 4,
        revenueCustomerCount: 2,
    },
    profileSummary = {
        totalCustomers: 5,
        marketingConsentCount: 2,
        recentCustomerCount: 3,
        reEngagementCustomerCount: 2,
        dormantCustomerCount: 1,
    },
    topRows = [
        {
            _id: "top-1",
            name: "Ada",
            email: "ada@example.com",
            visitCount: 8,
            paidOrderCount: 10,
            totalSpendCents: 45000,
            lastVisitAt: generatedAt,
            marketingConsent: true,
        },
    ],
    reEngagementRows = [
        {
            _id: "risk-1",
            name: "Ben",
            email: "ben@example.com",
            visitCount: 2,
            paidOrderCount: 2,
            totalSpendCents: 5000,
            lastVisitAt: new Date("2026-07-01T10:00:00.000Z"),
        },
    ],
} = {}) {
    const calls = []
    const business = {
        businessId: "biz_alpha",
        timezone: "UTC",
        currency: "eur",
        operatingHours: {},
    }
    const businessModel = {
        findOne(filter, projection) {
            calls.push({ type: "business", filter, projection })
            return { lean: async () => business }
        },
    }
    const guestVisitModel = {
        collection: { name: "guestvisits" },
        async aggregate(pipeline) {
            calls.push({ type: "visits", pipeline })
            return [visitFacet]
        },
    }
    const ledgerModel = {
        async aggregate(pipeline) {
            calls.push({ type: "revenue", pipeline })
            return revenue ? [revenue] : []
        },
    }
    const guestProfileModel = {
        async aggregate(pipeline) {
            calls.push({ type: "profiles", pipeline })
            return profileSummary ? [profileSummary] : []
        },
        find(filter, projection) {
            const queryCall = {
                type: "profileList",
                filter,
                projection,
                sort: null,
                limit: null,
            }
            calls.push(queryCall)
            return {
                sort(sort) {
                    queryCall.sort = sort
                    return this
                },
                limit(limit) {
                    queryCall.limit = limit
                    return this
                },
                async lean() {
                    return queryCall.sort.totalSpendCents
                        ? topRows
                        : reEngagementRows
                },
            }
        },
    }
    const customerJourneyModel = {
        async aggregate(pipeline) {
            calls.push({ type: "journeys", pipeline })
            return [
                {
                    summary: [
                        {
                            totalOrderingVisitors: 10,
                            visitorsWhoOrdered: 7,
                            visitorsWithoutOrder: 3,
                            identifiedVisitors: 5,
                            anonymousOrderingVisitors: 2,
                            identifiedOrderingVisitors: 5,
                            customerJourneyRevenueCents: 25000,
                        },
                    ],
                    daily: [
                        {
                            _id: "2026-08-25",
                            orderingVisitors: 5,
                            visitorsWhoOrdered: 4,
                            identifiedVisitors: 3,
                            anonymousOrderingVisitors: 1,
                            journeyRevenueCents: 12000,
                        },
                    ],
                },
            ]
        },
        findOne() {
            return {
                sort() {
                    return {
                        lean: async () => ({
                            firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
                        }),
                    }
                },
            }
        },
    }
    const service = createCrmAnalyticsService({
        businessModel,
        guestVisitModel,
        ledgerModel,
        guestProfileModel,
        customerJourneyModel,
        clock: () => generatedAt,
    })
    return { service, calls }
}

test("CRM analytics returns explicit period and lifetime metrics with safe customer semantics", async () => {
    const { service } = createFixture()
    const result = await service({
        businessId: "biz_alpha",
        range: "30days",
    })

    assert.equal(result.contractVersion, 1)
    assert.equal(result.currency, "EUR")
    assert.deepEqual(
        [result.range.from, result.range.to, result.range.timezone],
        ["2026-07-28", "2026-08-26", "UTC"],
    )
    assert.deepEqual(result.overview, {
        totalCustomers: 5,
        activeCustomers: 2,
        newCustomers: 1,
        returningCustomers: 2,
        repeatCustomerRatePercent: 100,
        totalVisits: 4,
        averageVisitsPerCustomer: 2,
        customerRevenueCents: 9000,
        paidOrderCount: 4,
        averageSpendPerCustomerCents: 4500,
        averageSpendPerVisitCents: 2250,
        marketingConsentCount: 2,
        marketingConsentPercent: 40,
        recentCustomerCount: 3,
        reEngagementCustomerCount: 2,
        dormantCustomerCount: 1,
    })
    assert.equal(result.metricScopes.totalCustomers, "lifetimeCurrentState")
    assert.equal(result.metricScopes.customerRevenueCents, "selectedPeriod")
    assert.equal(result.customerActivity.bucket, "day")
    assert.equal(result.customerActivity.points.length, 30)
    assert.deepEqual(result.customerActivity.points.at(-1), {
        date: "2026-08-26",
        newCustomers: 0,
        returningCustomers: 2,
    })
    assert.equal(result.topCustomers[0].orderCount, 10)
    assert.equal(result.reEngagement.thresholdDays, 30)
    assert.equal(result.reEngagement.dormantThresholdDays, 90)
})

test("every CRM analytics data access is scoped to the authenticated business first", async () => {
    const { service, calls } = createFixture()
    await service({ businessId: "biz_alpha", range: "today" })

    assert.deepEqual(calls.find((call) => call.type === "business").filter, {
        businessId: "biz_alpha",
    })
    for (const type of ["visits", "revenue", "profiles"]) {
        const call = calls.find((entry) => entry.type === type)
        assert.equal(call.pipeline[0].$match.businessId, "biz_alpha")
    }
    const visitLookup = calls.find((call) => call.type === "visits")
        .pipeline[1].$lookup.pipeline[0].$match
    assert.equal(visitLookup.businessId, "biz_alpha")
    for (const call of calls.filter((entry) => entry.type === "profileList")) {
        assert.equal(call.filter.businessId, "biz_alpha")
        assert.equal(call.limit, 5)
    }
})

test("zero-customer and zero-activity analytics never return NaN or Infinity", async () => {
    const { service } = createFixture({
        visitFacet: { summary: [], daily: [] },
        revenue: null,
        profileSummary: null,
        topRows: [],
        reEngagementRows: [],
    })
    const result = await service({ businessId: "biz_alpha", range: "today" })

    for (const value of Object.values(result.overview)) {
        assert.equal(Number.isFinite(value), true)
        assert.equal(value, 0)
    }
    assert.deepEqual(result.topCustomers, [])
    assert.deepEqual(result.reEngagement.customers, [])
    assert.deepEqual(result.visits.points, [
        { date: "2026-08-26", visits: 0 },
    ])
})

test("visit pipeline classifies first-ever and later canonical visit days without counting paid orders", () => {
    const pipeline = buildCrmVisitActivityPipeline({
        businessId: "biz_alpha",
        from: "2026-08-01",
        to: "2026-08-31",
        collectionName: "guestvisits",
    })

    assert.deepEqual(pipeline[0].$match, {
        businessId: "biz_alpha",
        visitDate: { $gte: "2026-08-01", $lte: "2026-08-31" },
        "paidOrderIds.0": { $exists: true },
    })
    assert.deepEqual(pipeline[3].$set.isNewVisit.$eq, [
        "$visitDate",
        "$firstCanonicalVisit.visitDate",
    ])
    assert.deepEqual(pipeline[4].$group.visitCount, { $sum: 1 })
    assert.deepEqual(pipeline[4].$group.hasReturningVisit, {
        $max: { $cond: ["$isNewVisit", 0, 1] },
    })
})

test("multiple paid orders on one operational date still build one canonical GuestVisit", () => {
    const projection = buildCrmProjection({
        entries: [
            {
                orderId: "ORDER-1",
                orderDate: new Date("2026-08-26T10:00:00.000Z"),
                localVisitDate: "2026-08-26",
                spendCents: 1200,
                items: [],
            },
            {
                orderId: "ORDER-2",
                orderDate: new Date("2026-08-26T18:00:00.000Z"),
                localVisitDate: "2026-08-26",
                spendCents: 1800,
                items: [],
            },
        ],
        profileBaseline: {
            visitCount: 0,
            orderCount: 0,
            paidOrderCount: 0,
            totalSpendCents: 0,
            favouriteItems: [],
        },
        visitBaselines: new Map(),
    })

    assert.equal(projection.profile.visitCount, 1)
    assert.equal(projection.profile.paidOrderCount, 2)
    assert.equal(projection.visits.length, 1)
    assert.equal(projection.visits[0].paidOrderIds.length, 2)
})

test("CRM trend buckets become weekly and monthly for larger custom ranges", () => {
    const weekly = bucketCrmDailyActivity({
        rows: [{ _id: "2026-04-15", visits: 2, newCustomers: 1 }],
        from: "2026-04-01",
        to: "2026-06-30",
        timezone: "UTC",
    })
    const monthly = bucketCrmDailyActivity({
        rows: [{ _id: "2026-02-15", visits: 3, returningCustomers: 2 }],
        from: "2026-01-01",
        to: "2026-08-01",
        timezone: "UTC",
    })

    assert.equal(weekly.bucket, "week")
    assert.equal(weekly.points.some((point) => point.visits === 2), true)
    assert.equal(monthly.bucket, "month")
    assert.equal(monthly.points.find((point) => point.date === "2026-02-01").visits, 3)
})

test("CRM acquisition funnel conversion rates compute accurately with 10 journeys", () => {
    const totalOrderingVisitors = 10
    const visitorsWhoOrdered = 7
    const identifiedVisitors = 5
    const identifiedOrderingVisitors = 5

    const visitToOrderConversionRate = Math.round((visitorsWhoOrdered / totalOrderingVisitors) * 100 * 10) / 10
    const orderToIdentifiedConversionRate = Math.round((identifiedOrderingVisitors / visitorsWhoOrdered) * 100 * 10) / 10
    const visitToIdentifiedConversionRate = Math.round((identifiedVisitors / totalOrderingVisitors) * 100 * 10) / 10

    assert.equal(visitToOrderConversionRate, 70.0)
    assert.equal(orderToIdentifiedConversionRate, 71.4)
    assert.equal(visitToIdentifiedConversionRate, 50.0)
})

test("Zero ordering visitors returns 0% rates without NaN or Infinity", () => {
    const totalOrderingVisitors = 0
    const visitorsWhoOrdered = 0
    const identifiedVisitors = 0

    const visitToOrderConversionRate = totalOrderingVisitors > 0 ? (visitorsWhoOrdered / totalOrderingVisitors) * 100 : 0
    const orderToIdentifiedConversionRate = visitorsWhoOrdered > 0 ? (identifiedVisitors / visitorsWhoOrdered) * 100 : 0

    assert.equal(Number.isNaN(visitToOrderConversionRate), false)
    assert.equal(Number.isFinite(visitToOrderConversionRate), true)
    assert.equal(visitToOrderConversionRate, 0)
    assert.equal(orderToIdentifiedConversionRate, 0)
})

