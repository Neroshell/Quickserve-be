import assert from "node:assert/strict"
import test from "node:test"
import {
    FOOD_SERVICE_ACTIVE_STATUSES,
    FOOD_SERVICE_COMPLETED_STATUSES,
    getFoodServiceAnalytics,
} from "../src/services/analytics/foodServiceAnalyticsService.js"

const businessId = "biz_food"
const analyticsRange = {
    preset: "today",
    timezone: "UTC",
    from: "2026-07-28",
    to: "2026-07-28",
    startUtc: new Date("2026-07-28T02:00:00.000Z"),
    endUtcExclusive: new Date("2026-07-29T02:00:00.000Z"),
    comparison: {
        from: "2026-07-27",
        to: "2026-07-27",
        startUtc: new Date("2026-07-27T02:00:00.000Z"),
        endUtcExclusive: new Date(
            "2026-07-28T02:00:00.000Z"
        ),
    },
}

const financials = {
    current: {
        grossCents: 5500,
        netToBusinessCents: null,
        transactionCount: 2,
        averageTransactionValueCents: 2750,
        totalTipsCents: 500,
        averageTipCents: 250,
        highestTipCents: 300,
        ordersWithTips: 2,
        tipRatePercent: 100,
    },
    comparison: {
        grossCents: 4400,
        netToBusinessCents: null,
        transactionCount: 2,
        averageTransactionValueCents: 2200,
        totalTipsCents: 200,
        averageTipCents: 200,
        highestTipCents: 200,
        ordersWithTips: 1,
        tipRatePercent: 50,
    },
    averageOrderValueComparisonPercent: 25,
    revenueByDay: [
        {
            date: "2026-07-28",
            grossCents: 5500,
            transactionCount: 2,
        },
    ],
}

function createModels({ empty = false } = {}) {
    const orderPipelines = []
    const serviceRequestPipelines = []
    const servicePointQueries = []

    const orderModel = {
        async aggregate(pipeline) {
            orderPipelines.push(pipeline)
            if (empty) return [{ }]
            return [
                {
                    overview: [
                        {
                            activeOrders: 3,
                            completedOrders: 2,
                            totalPrepMinutes: 50,
                            prepTimeCount: 2,
                        },
                    ],
                    peakOrderHour: [
                        { _id: 10, orderCount: 3 },
                    ],
                    hourlyOrders: [
                        {
                            _id: 10,
                            orderCount: 3,
                            paidRevenueCents: 5000,
                        },
                    ],
                    totalItemsSold: [{ quantity: 4 }],
                    topItems: [
                        {
                            _id: "Burger",
                            quantity: 2,
                            paidItemRevenueCents: 2000,
                            category: "mains",
                        },
                        {
                            _id: "Soda",
                            quantity: 1,
                            paidItemRevenueCents: 1000,
                            category: "beverages",
                        },
                    ],
                    categoryPerformance: [
                        {
                            _id: "mains",
                            quantity: 3,
                            paidItemRevenueCents: 4000,
                        },
                        {
                            _id: "beverages",
                            quantity: 1,
                            paidItemRevenueCents: 1000,
                        },
                    ],
                    orderTypeCounts: [
                        { _id: "dine-in", orderCount: 3 },
                        { _id: "takeout", orderCount: 1 },
                    ],
                    orderTypeRevenue: [
                        {
                            _id: "dine-in",
                            paidRevenueCents: 3000,
                        },
                        {
                            _id: "takeout",
                            paidRevenueCents: 2000,
                        },
                    ],
                    channelCounts: [
                        { _id: "self", orderCount: 3 },
                        { _id: "waitstaff", orderCount: 1 },
                    ],
                    channelRevenue: [
                        {
                            _id: "self",
                            paidRevenueCents: 3000,
                        },
                        {
                            _id: "waitstaff",
                            paidRevenueCents: 2000,
                        },
                    ],
                    servicePointPerformance: [
                        {
                            _id: "sp_table1",
                            displayLabel: "Persisted Table",
                            orderCount: 3,
                            paidOrders: 2,
                            unpaidOrders: 1,
                            paidRevenueCents: 5000,
                        },
                    ],
                    paymentStaff: [
                        {
                            _id: "staff-1",
                            name: "Alex",
                            paymentsConfirmed: 2,
                            totalOfflinePaymentsConfirmedCents: 5000,
                        },
                    ],
                    servedStaff: [
                        {
                            _id: "staff-1",
                            name: "Alex",
                            ordersServed: 3,
                        },
                    ],
                },
            ]
        },
    }

    const serviceRequestModel = {
        async aggregate(pipeline) {
            serviceRequestPipelines.push(pipeline)
            if (empty) return [{ }]
            return [
                {
                    byStatus: [
                        { _id: "pending", count: 1 },
                        { _id: "acknowledged", count: 1 },
                        { _id: "resolved", count: 2 },
                        { _id: "missed", count: 1 },
                    ],
                    byReason: [
                        { _id: "request_bill", count: 2 },
                        { _id: "assistance", count: 1 },
                        { _id: "custom reason", count: 1 },
                    ],
                    responseTimes: [{ average: 45.4 }],
                    resolutionTimes: [{ average: 100.6 }],
                    acknowledgedStaff: [
                        {
                            _id: "staff-1",
                            name: "Alex",
                            count: 2,
                            totalResponseMilliseconds: 60000,
                            responseCount: 2,
                        },
                    ],
                    resolvedStaff: [
                        {
                            _id: "staff-1",
                            name: "Alex",
                            count: 1,
                            totalResolutionMilliseconds: 120000,
                            resolutionCount: 1,
                        },
                    ],
                },
            ]
        },
    }

    const servicePointModel = {
        find(filter) {
            servicePointQueries.push(filter)
            return {
                lean: async () => [
                    {
                        servicePointId: "sp_table1",
                        label: "Table 1",
                        code: "T1",
                        servicePointType: "table",
                    },
                ],
            }
        },
    }

    return {
        orderModel,
        serviceRequestModel,
        servicePointModel,
        orderPipelines,
        serviceRequestPipelines,
        servicePointQueries,
    }
}

test("food-service status sets explicitly count ready as active and never count cancelled as active", () => {
    assert.deepEqual(FOOD_SERVICE_ACTIVE_STATUSES, [
        "placed",
        "in_progress",
        "ready",
    ])
    assert.deepEqual(FOOD_SERVICE_COMPLETED_STATUSES, [
        "completed",
    ])
    assert.equal(
        FOOD_SERVICE_ACTIVE_STATUSES.includes("cancelled"),
        false
    )
    assert.equal(
        FOOD_SERVICE_ACTIVE_STATUSES.includes("unknown"),
        false
    )
})

test("food-service analytics returns the v2 overview, real comparison, tip cents, ISO revenue days, and hourly buckets", async () => {
    const models = createModels()
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials,
        ...models,
    })

    assert.deepEqual(result.overview, {
        paidRevenueCents: 5500,
        activeOrders: 3,
        completedOrders: 2,
        averageOrderValueCents: 2750,
        comparisonAverageOrderValueCents: 2200,
        averageOrderValueComparisonPercent: 25,
        averagePrepTimeMinutes: 25,
        peakOrderHour: "10AM",
        totalItemsSold: 4,
    })
    assert.deepEqual(result.tips, {
        totalTipsCents: 500,
        averageTipCents: 250,
        highestTipCents: 300,
        ordersWithTips: 2,
        tipRatePercent: 100,
    })
    assert.deepEqual(result.revenueByDay, [
        {
            date: "2026-07-28",
            grossCents: 5500,
            orderCount: 2,
        },
    ])
    assert.equal(result.hourlyOrders.length, 24)
    assert.deepEqual(result.hourlyOrders[10], {
        hour: "10AM",
        orderCount: 3,
        paidRevenueCents: 5000,
    })
})

test("food-service item/category, type, and channel breakdowns use integer cents and actual item revenue only", async () => {
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials,
        ...createModels(),
    })

    assert.deepEqual(result.topItems[0], {
        itemName: "Burger",
        quantity: 2,
        paidItemRevenueCents: 2000,
        category: "mains",
    })
    assert.deepEqual(result.categoryPerformance, [
        {
            category: "Mains",
            quantity: 3,
            paidItemRevenueCents: 4000,
            percentageOfItemRevenue: 80,
        },
        {
            category: "Beverages",
            quantity: 1,
            paidItemRevenueCents: 1000,
            percentageOfItemRevenue: 20,
        },
    ])
    assert.equal(result.categoryRevenueBasis, "paidItemRevenue")
    assert.equal(
        result.categoryPerformance.some(
            (row) => row.category === "Remaining"
        ),
        false
    )
    assert.deepEqual(result.orderTypeBreakdown, [
        {
            type: "dine-in",
            orderCount: 3,
            paidRevenueCents: 3000,
            orderPercentage: 75,
            revenuePercentage: 60,
        },
        {
            type: "takeout",
            orderCount: 1,
            paidRevenueCents: 2000,
            orderPercentage: 25,
            revenuePercentage: 40,
        },
    ])
    assert.deepEqual(result.channelBreakdown, [
        {
            channel: "self",
            label: "Self Ordering",
            orderCount: 3,
            paidRevenueCents: 3000,
            orderPercentage: 75,
            revenuePercentage: 60,
        },
        {
            channel: "waitstaff",
            label: "Staff-Assisted Ordering",
            orderCount: 1,
            paidRevenueCents: 2000,
            orderPercentage: 25,
            revenuePercentage: 40,
        },
    ])
})

test("ServicePoint performance excludes unpaid value from paid revenue while retaining paid and unpaid counts", async () => {
    const models = createModels()
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials,
        ...models,
    })

    assert.deepEqual(result.servicePointPerformance, [
        {
            servicePointId: "sp_table1",
            label: "Table 1",
            code: "T1",
            servicePointType: "table",
            orderCount: 3,
            paidOrders: 2,
            unpaidOrders: 1,
            paidRevenueCents: 5000,
            averagePaidOrderValueCents: 2500,
        },
    ])
    assert.deepEqual(models.servicePointQueries, [
        {
            businessId,
            servicePointId: {
                $in: ["sp_table1"],
            },
        },
    ])

    const pipelineText = JSON.stringify(
        models.orderPipelines[0]
    )
    assert.equal(
        pipelineText.includes(
            '"paidRevenueCents":{"$sum":{"$cond":[{"$eq":["$paymentStatus","paid"]}'
        ),
        true
    )
})

test("service requests and staff performance retain focused service metrics with cents for offline payments", async () => {
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials,
        ...createModels(),
    })

    assert.deepEqual(result.serviceRequests, {
        total: 5,
        pending: 1,
        acknowledged: 1,
        resolved: 2,
        missed: 1,
        byReason: {
            request_bill: 2,
            assistance: 1,
            emergency: 0,
            other: 1,
        },
        averageResponseTimeSeconds: 45,
        averageResolutionTimeSeconds: 101,
    })
    assert.deepEqual(result.staffPerformance, [
        {
            staffId: "staff-1",
            name: "Alex",
            callsAcknowledged: 2,
            callsResolved: 1,
            averageResponseTimeSeconds: 30,
            averageResolutionTimeSeconds: 120,
            ordersServed: 3,
            paymentsConfirmed: 2,
            totalOfflinePaymentsConfirmedCents: 5000,
        },
    ])
})

test("all food-service pipelines and ServicePoint enrichment remain tenant scoped", async () => {
    const models = createModels()
    await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials,
        ...models,
    })

    assert.equal(
        models.orderPipelines[0][0].$match.businessId,
        businessId
    )
    assert.deepEqual(
        models.orderPipelines[0][0].$match.$or[0],
        {
            createdAt: {
                $gte: analyticsRange.startUtc,
                $lt: analyticsRange.endUtcExclusive,
            },
        }
    )
    assert.deepEqual(models.serviceRequestPipelines[0][0], {
        $match: {
            businessId,
            module: "foodService",
            createdAt: {
                $gte: analyticsRange.startUtc,
                $lt: analyticsRange.endUtcExclusive,
            },
        },
    })
    assert.equal(models.servicePointQueries[0].businessId, businessId)
})

test("empty enabled food-service module returns zero values and empty domain arrays", async () => {
    const emptyFinancials = {
        ...financials,
        current: {
            ...financials.current,
            grossCents: 0,
            transactionCount: 0,
            averageTransactionValueCents: 0,
            totalTipsCents: 0,
            averageTipCents: 0,
            highestTipCents: 0,
            ordersWithTips: 0,
            tipRatePercent: 0,
        },
        comparison: {
            ...financials.comparison,
            averageTransactionValueCents: 0,
        },
        averageOrderValueComparisonPercent: 0,
        revenueByDay: [
            {
                date: "2026-07-28",
                grossCents: 0,
                transactionCount: 0,
            },
        ],
    }
    const models = createModels({ empty: true })
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials: emptyFinancials,
        ...models,
    })

    assert.deepEqual(result.overview, {
        paidRevenueCents: 0,
        activeOrders: 0,
        completedOrders: 0,
        averageOrderValueCents: 0,
        comparisonAverageOrderValueCents: 0,
        averageOrderValueComparisonPercent: 0,
        averagePrepTimeMinutes: 0,
        peakOrderHour: null,
        totalItemsSold: 0,
    })
    assert.equal(result.hourlyOrders.length, 24)
    assert.deepEqual(result.topItems, [])
    assert.deepEqual(result.categoryPerformance, [])
    assert.deepEqual(result.servicePointPerformance, [])
    assert.deepEqual(result.staffPerformance, [])
    assert.equal(models.servicePointQueries.length, 0)
})

test("null average-order comparison is preserved for growth from a zero prior period", async () => {
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange,
        financials: {
            ...financials,
            averageOrderValueComparisonPercent: null,
        },
        ...createModels(),
    })

    assert.equal(
        result.overview.averageOrderValueComparisonPercent,
        null
    )
})
