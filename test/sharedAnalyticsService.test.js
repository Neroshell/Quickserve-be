import assert from "node:assert/strict"
import test from "node:test"
import {
    calculateComparisonPercent,
    getSharedAnalytics,
} from "../src/services/analytics/sharedAnalyticsService.js"

const businessId = "biz_shared"
const analyticsRange = {
    preset: "7days",
    timezone: "Europe/Berlin",
    from: "2026-07-22",
    to: "2026-07-28",
    startUtc: new Date("2026-07-22T00:00:00.000Z"),
    endUtcExclusive: new Date("2026-07-29T00:00:00.000Z"),
    comparison: {
        from: "2026-07-15",
        to: "2026-07-21",
        startUtc: new Date("2026-07-15T00:00:00.000Z"),
        endUtcExclusive: new Date("2026-07-22T00:00:00.000Z"),
    },
}

function createOrderModel({
    currentNetKnownCount = 2,
    currentRows,
} = {}) {
    const pipelines = []
    return {
        pipelines,
        async aggregate(pipeline) {
            pipelines.push(pipeline)
            return [
                {
                    currentSummary: currentRows || [
                        {
                            grossCents: 5500,
                            netCents: 5000,
                            netKnownCount: currentNetKnownCount,
                            transactionCount: 2,
                            totalTipsCents: 500,
                            highestTipCents: 300,
                            ordersWithTips: 2,
                        },
                    ],
                    comparisonSummary: [
                        {
                            grossCents: 4400,
                            netCents: 4000,
                            netKnownCount: 2,
                            transactionCount: 2,
                            totalTipsCents: 200,
                            highestTipCents: 200,
                            ordersWithTips: 1,
                        },
                    ],
                    revenueByDay: [
                        {
                            _id: "2026-07-22",
                            grossCents: 2500,
                            transactionCount: 1,
                        },
                        {
                            _id: "2026-07-28",
                            grossCents: 3000,
                            transactionCount: 1,
                        },
                    ],
                    hourlyRevenue: [
                        {
                            _id: 10,
                            paidRevenueCents: 5500,
                            paidOrderCount: 2,
                        },
                    ],
                },
            ]
        },
    }
}

function createReservationModel({
    currentNetKnownCount = 1,
} = {}) {
    const pipelines = []
    return {
        pipelines,
        async aggregate(pipeline) {
            pipelines.push(pipeline)
            return [
                {
                    currentSummary: [
                        {
                            grossCents: 30000,
                            netCents: 28000,
                            netKnownCount:
                                currentNetKnownCount,
                            transactionCount: 1,
                        },
                    ],
                    comparisonSummary: [
                        {
                            grossCents: 20000,
                            netCents: 18500,
                            netKnownCount: 1,
                            transactionCount: 1,
                        },
                    ],
                    revenueByDay: [
                        {
                            _id: "2026-07-22",
                            grossCents: 30000,
                            transactionCount: 1,
                        },
                    ],
                },
            ]
        },
    }
}

test("comparison percentages handle positive, negative, zero, and growth from zero without fake 100 percent", () => {
    assert.equal(calculateComparisonPercent(120, 100), 20)
    assert.equal(calculateComparisonPercent(80, 100), -20)
    assert.equal(calculateComparisonPercent(0, 0), 0)
    assert.equal(calculateComparisonPercent(100, 0), null)
})

test("shared analytics returns paid gross cents, reliable net, tips, comparisons, and one food-service contribution", async () => {
    const orderModel = createOrderModel()
    const result = await getSharedAnalytics({
        businessId,
        analyticsRange,
        orderModel,
    })

    assert.deepEqual(result.shared.paidRevenue, {
        grossCents: 5500,
        netToBusinessCents: 5000,
        transactionCount: 2,
        averageTransactionValueCents: 2750,
        comparisonPercent: 25,
    })
    assert.deepEqual(result.shared.revenueByModule, [
        {
            module: "foodService",
            grossCents: 5500,
            transactionCount: 2,
        },
    ])
    assert.equal(
        result.shared.revenueByModule.reduce(
            (sum, row) => sum + row.grossCents,
            0
        ),
        result.shared.paidRevenue.grossCents
    )
    assert.deepEqual(result.foodServiceFinancials.current, {
        grossCents: 5500,
        netToBusinessCents: 5000,
        transactionCount: 2,
        averageTransactionValueCents: 2750,
        totalTipsCents: 500,
        averageTipCents: 250,
        highestTipCents: 300,
        ordersWithTips: 2,
        tipRatePercent: 100,
    })
    assert.equal(
        result.foodServiceFinancials.averageOrderValueComparisonPercent,
        25
    )
    assert.equal(result.shared.revenueByDay.length, 7)
    assert.deepEqual(result.shared.revenueByDay[0], {
        date: "2026-07-22",
        grossCents: 2500,
        transactionCount: 1,
    })
    assert.equal(result.foodServiceFinancials.hourlyOrders.length, 24)
    assert.deepEqual(result.foodServiceFinancials.hourlyOrders[10], {
        hour: "10AM",
        paidRevenueCents: 5500,
        paidOrderCount: 2,
    })
})

test("shared analytics returns null net when any paid order lacks authoritative persisted net cents", async () => {
    const result = await getSharedAnalytics({
        businessId,
        analyticsRange,
        orderModel: createOrderModel({
            currentNetKnownCount: 1,
        }),
    })

    assert.equal(
        result.shared.paidRevenue.netToBusinessCents,
        null
    )
})

test("empty paid range returns zero shared facts without fabricating module totals", async () => {
    const result = await getSharedAnalytics({
        businessId,
        analyticsRange,
        orderModel: createOrderModel({
            currentRows: [],
        }),
    })

    assert.deepEqual(result.shared.paidRevenue, {
        grossCents: 0,
        netToBusinessCents: 0,
        transactionCount: 0,
        averageTransactionValueCents: 0,
        comparisonPercent: -100,
    })
    assert.deepEqual(result.shared.revenueByModule, [
        {
            module: "foodService",
            grossCents: 0,
            transactionCount: 0,
        },
    ])
})

test("financial aggregation is tenant scoped, paid-only, paidAt-first, and does not exclude paid cancelled orders", async () => {
    const orderModel = createOrderModel()
    await getSharedAnalytics({
        businessId,
        analyticsRange,
        orderModel,
    })

    const pipeline = orderModel.pipelines[0]
    assert.equal(pipeline[0].$match.businessId, businessId)
    assert.equal(
        pipeline[0].$match.paymentStatus,
        "paid"
    )
    assert.deepEqual(
        pipeline[0].$match.$or[0],
        {
            paidAt: {
                $gte: analyticsRange.startUtc,
                $lt: analyticsRange.endUtcExclusive,
            },
        }
    )
    assert.deepEqual(
        pipeline[0].$match.$or[2],
        {
            paidAt: null,
            createdAt: {
                $gte: analyticsRange.startUtc,
                $lt: analyticsRange.endUtcExclusive,
            },
        }
    )
    assert.equal(
        JSON.stringify(pipeline[1]).includes(
            '"$ifNull":["$paidAt","$createdAt"]'
        ),
        true
    )
    assert.equal(
        JSON.stringify(pipeline[1]).includes('"$grossAmount"'),
        true
    )
    assert.equal(
        JSON.stringify(pipeline[1]).includes('"$total"'),
        true
    )
    assert.equal(
        JSON.stringify(pipeline).includes('"status":"cancelled"'),
        false
    )
})

test("lodging-only shared revenue uses paid stay reservations and never queries orders", async () => {
    const reservationModel = createReservationModel()
    const result = await getSharedAnalytics({
        businessId,
        enabledAnalyticsModules: ["lodging"],
        lodgingCalendarRange: analyticsRange,
        reservationModel,
        orderModel: {
            async aggregate() {
                throw new Error(
                    "food query must not execute"
                )
            },
        },
    })

    assert.deepEqual(result.shared.paidRevenue, {
        grossCents: 30000,
        netToBusinessCents: 28000,
        transactionCount: 1,
        averageTransactionValueCents: 30000,
        comparisonPercent: 50,
    })
    assert.deepEqual(result.shared.revenueByModule, [
        {
            module: "lodging",
            grossCents: 30000,
            transactionCount: 1,
        },
    ])
    assert.equal(
        result.lodgingFinancials.current.grossCents,
        30000
    )

    const pipeline = reservationModel.pipelines[0]
    assert.equal(
        pipeline[0].$match.businessId,
        businessId
    )
    assert.equal(
        pipeline[0].$match.paymentStatus,
        "paid"
    )
    assert.ok(pipeline[0].$match.checkInDate.$regex)
    assert.ok(pipeline[0].$match.checkOutDate.$regex)
    assert.equal(pipeline[0].$match.$or.length, 2)
    assert.equal(
        JSON.stringify(pipeline[0]).includes("createdAt"),
        false
    )
    assert.equal(
        JSON.stringify(pipeline[1]).includes(
            '"$amountPaidCents"'
        ),
        true
    )
})

test("hybrid shared revenue combines each module once and merges local daily buckets", async () => {
    const result = await getSharedAnalytics({
        businessId,
        enabledAnalyticsModules: [
            "lodging",
            "foodService",
        ],
        foodOperationalRange: analyticsRange,
        lodgingCalendarRange: analyticsRange,
        orderModel: createOrderModel(),
        reservationModel: createReservationModel(),
    })

    assert.deepEqual(result.shared.paidRevenue, {
        grossCents: 35500,
        netToBusinessCents: 33000,
        transactionCount: 3,
        averageTransactionValueCents: 11833,
        comparisonPercent: 45.49,
    })
    assert.deepEqual(result.shared.revenueByModule, [
        {
            module: "lodging",
            grossCents: 30000,
            transactionCount: 1,
        },
        {
            module: "foodService",
            grossCents: 5500,
            transactionCount: 2,
        },
    ])
    assert.deepEqual(result.shared.revenueByDay[0], {
        date: "2026-07-22",
        grossCents: 32500,
        transactionCount: 2,
    })
    assert.equal(
        result.shared.revenueByModule.reduce(
            (sum, row) => sum + row.grossCents,
            0
        ),
        result.shared.paidRevenue.grossCents
    )
})

test("hybrid shared net is null when any included lodging payment lacks reliable persisted net", async () => {
    const result = await getSharedAnalytics({
        businessId,
        enabledAnalyticsModules: [
            "foodService",
            "lodging",
        ],
        foodOperationalRange: analyticsRange,
        lodgingCalendarRange: analyticsRange,
        orderModel: createOrderModel(),
        reservationModel: createReservationModel({
            currentNetKnownCount: 0,
        }),
    })

    assert.equal(
        result.shared.paidRevenue.netToBusinessCents,
        null
    )
})
