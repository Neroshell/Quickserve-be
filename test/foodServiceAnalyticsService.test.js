import assert from "node:assert/strict"
import test from "node:test"
import { getFoodServiceAnalytics } from "../src/services/analytics/foodServiceAnalyticsService.js"

const businessId = "biz_food"
const startDate = new Date("2026-07-28T00:00:00.000Z")
const endDate = new Date("2026-07-29T00:00:00.000Z")

const orders = [
    {
        businessId,
        orderId: "paid-self",
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        readyAt: new Date("2026-07-28T08:20:00.000Z"),
        status: "completed",
        paymentStatus: "paid",
        orderType: "dine-in",
        orderSource: "self",
        total: 33,
        tipAmount: 3,
        items: [
            {
                itemName: "Burger",
                category: "mains",
                quantity: 2,
                lineTotal: 20,
            },
            {
                itemName: "Soda",
                category: "beverages",
                quantity: 1,
                lineTotal: 10,
            },
        ],
    },
    {
        businessId,
        orderId: "paid-staff",
        createdAt: new Date("2026-07-28T09:00:00.000Z"),
        completedAt: new Date("2026-07-28T09:30:00.000Z"),
        status: "ready",
        paymentStatus: "paid",
        orderType: "takeout",
        orderSource: "waitstaff",
        total: 22,
        tipAmount: 2,
        items: [
            {
                itemName: "Salad",
                category: "mains",
                quantity: 1,
                lineTotal: 20,
            },
        ],
    },
    {
        businessId,
        orderId: "unpaid",
        createdAt: new Date("2026-07-28T10:00:00.000Z"),
        status: "placed",
        paymentStatus: "unpaid",
        orderType: "dine-in",
        orderSource: "self",
        total: 15,
        tipAmount: 0,
        items: [
            {
                itemName: "Fries",
                category: "sides",
                quantity: 1,
                lineTotal: 15,
            },
        ],
    },
    {
        businessId,
        orderId: "cancelled",
        createdAt: new Date("2026-07-28T11:00:00.000Z"),
        status: "cancelled",
        paymentStatus: "unpaid",
        orderType: "takeout",
        orderSource: "self",
        total: 12,
        tipAmount: 0,
        items: [],
    },
    {
        businessId: "biz_other",
        orderId: "cross-tenant",
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        status: "completed",
        paymentStatus: "paid",
        orderType: "dine-in",
        orderSource: "self",
        total: 999,
        tipAmount: 99,
        items: [
            {
                itemName: "Other Tenant Item",
                category: "mains",
                quantity: 100,
                lineTotal: 900,
            },
        ],
    },
]

function createModels({ includeData = true } = {}) {
    const matches = []
    const servicePointQueries = []

    const orderModel = {
        find(filter) {
            matches.push(filter)
            const matchingOrders = includeData
                ? orders.filter(
                      (order) =>
                          order.businessId === filter.businessId &&
                          order.createdAt >= filter.createdAt.$gte &&
                          order.createdAt < filter.createdAt.$lt
                  )
                : []
            return {
                lean: async () => matchingOrders,
            }
        },
        async aggregate(pipeline) {
            matches.push(pipeline[0].$match)
            const groupId = pipeline.find((stage) => stage.$group)?.$group
                ?._id
            if (!includeData) return []
            if (groupId === "$servicePointLabel") {
                return [
                    {
                        _id: "sp_table1",
                        label: "sp_table1",
                        orderCount: 3,
                        totalRevenue: 70,
                        paidOrders: 2,
                        unpaidOrders: 1,
                    },
                ]
            }
            if (groupId === "$paidByStaffId") {
                return [
                    {
                        _id: "staff-1",
                        name: "Alex",
                        paymentsConfirmed: 2,
                        totalOfflinePaymentsConfirmed: 50,
                    },
                ]
            }
            if (groupId === "$servedByStaffId") {
                return [
                    {
                        _id: "staff-1",
                        name: "Alex",
                        ordersServed: 3,
                    },
                ]
            }
            throw new Error(`Unexpected Order aggregation: ${groupId}`)
        },
    }

    const serviceRequestModel = {
        async aggregate(pipeline) {
            matches.push(pipeline[0].$match)
            if (!includeData) return []
            const facet = pipeline[1].$facet
            if (facet.byStatus) {
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
                        responseTimes: [{ avg: 45.4 }],
                        resolutionTimes: [{ avg: 100.6 }],
                    },
                ]
            }
            if (facet.acknowledged) {
                return [
                    {
                        acknowledged: [
                            {
                                _id: "staff-1",
                                name: "Alex",
                                count: 2,
                                totalRespMs: 60000,
                                respCount: 2,
                            },
                        ],
                        resolved: [
                            {
                                _id: "staff-1",
                                name: "Alex",
                                count: 1,
                                totalResolMs: 120000,
                                resolCount: 1,
                            },
                        ],
                    },
                ]
            }
            throw new Error("Unexpected ServiceRequest aggregation")
        },
    }

    const servicePointModel = {
        find(filter) {
            servicePointQueries.push(filter)
            return {
                lean: async () =>
                    includeData
                        ? [
                              {
                                  servicePointId: "sp_table1",
                                  label: "Table 1",
                                  code: "T1",
                              },
                          ]
                        : [],
            }
        },
    }

    return {
        orderModel,
        serviceRequestModel,
        servicePointModel,
        matches,
        servicePointQueries,
    }
}

function getRange() {
    return {
        preset: "today",
        startDate,
        endDate,
        timezone: "UTC",
    }
}

test("food-service analytics preserves current paid, unpaid, cancelled, tip, item, and preparation behavior", async () => {
    const models = createModels()
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange: getRange(),
        ...models,
    })

    assert.equal(result.stats.todayRevenue, 50)
    assert.equal(result.stats.yesterdayRevenue, 0)
    assert.equal(result.stats.weekRevenue, 50)
    assert.equal(result.stats.activeOrders, 2)
    assert.equal(result.stats.completedToday, 1)
    assert.equal(result.stats.averageOrderValue, 25)
    assert.equal(result.stats.averagePrepTime, 25)
    assert.equal(result.stats.dineInCount, 2)
    assert.equal(result.stats.takeoutCount, 2)
    assert.equal(result.stats.totalItemsSold, 4)

    assert.equal(result.stats.totalTipsCollected, 5)
    assert.equal(result.stats.averageTip, 2.5)
    assert.equal(result.stats.highestTip, 3)
    assert.equal(result.stats.ordersWithTips, 2)
    assert.equal(result.stats.tipRate, 100)

    assert.deepEqual(result.topItems[0], {
        itemName: "Burger",
        quantity: 2,
        revenue: 20,
        category: "mains",
    })
    assert.deepEqual(result.categoryPerformance, [
        {
            category: "Mains",
            revenue: 40,
            quantity: 3,
            percentage: 80,
        },
        {
            category: "Beverages",
            revenue: 10,
            quantity: 1,
            percentage: 20,
        },
    ])
    assert.deepEqual(result.orderTypeBreakdown, [
        {
            type: "dine-in",
            count: 2,
            revenue: 30,
            percentage: 50,
        },
        {
            type: "takeout",
            count: 2,
            revenue: 20,
            percentage: 50,
        },
    ])
    assert.deepEqual(result.channelBreakdown, [
        {
            channel: "self",
            label: "Self Ordering",
            count: 3,
            revenue: 30,
            orderPercentage: 75,
            revenuePercentage: 60,
        },
        {
            channel: "waitstaff",
            label: "Staff-Assisted Ordering",
            count: 1,
            revenue: 20,
            orderPercentage: 25,
            revenuePercentage: 40,
        },
    ])
})

test("food-service analytics preserves service request, ServicePoint, and waitstaff response shapes", async () => {
    const models = createModels()
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange: getRange(),
        ...models,
    })

    assert.deepEqual(result.serviceCalls, {
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
        avgResponseTimeSeconds: 45,
        avgResolutionTimeSeconds: 101,
    })
    assert.deepEqual(result.tablePerformance, [
        {
            servicePointId: "sp_table1",
            label: "Table 1",
            code: "T1",
            servicePointType: "table",
            orderCount: 3,
            totalRevenue: 70,
            averageOrderValue: 23.33,
            paidOrders: 2,
            unpaidOrders: 1,
        },
    ])
    assert.deepEqual(result.waitstaffPerformance, [
        {
            staffId: "staff-1",
            name: "Alex",
            callsAcknowledged: 2,
            callsResolved: 1,
            avgResponseTimeSeconds: 30,
            avgResolutionTimeSeconds: 120,
            ordersServed: 3,
            paymentsConfirmed: 2,
            totalOfflinePaymentsConfirmed: 50,
        },
    ])
})

test("all food-service analytics queries remain tenant scoped and exclude another tenant", async () => {
    const models = createModels()
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange: getRange(),
        ...models,
    })

    assert.equal(result.stats.todayRevenue, 50)
    assert.equal(
        result.topItems.some(
            (item) => item.itemName === "Other Tenant Item"
        ),
        false
    )
    assert.ok(models.matches.length >= 6)
    for (const match of models.matches) {
        assert.equal(match.businessId, businessId)
        assert.deepEqual(match.createdAt, {
            $gte: startDate,
            $lt: endDate,
        })
    }
    assert.deepEqual(models.servicePointQueries, [
        {
            servicePointId: { $in: ["sp_table1"] },
            businessId,
        },
    ])
})

test("empty food-service range returns the legacy zero-valued flat DTO", async () => {
    const models = createModels({ includeData: false })
    const result = await getFoodServiceAnalytics({
        businessId,
        analyticsRange: getRange(),
        ...models,
    })

    assert.equal(result.stats.todayRevenue, 0)
    assert.equal(result.stats.activeOrders, 0)
    assert.equal(result.stats.peakHour, "N/A")
    assert.equal(result.hourlyOrders.length, 24)
    assert.equal(result.revenueByDay.length, 24)
    assert.deepEqual(result.topItems, [])
    assert.deepEqual(result.categoryPerformance, [])
    assert.deepEqual(result.tablePerformance, [])
    assert.deepEqual(result.waitstaffPerformance, [])
    assert.deepEqual(result.serviceCalls, {
        total: 0,
        pending: 0,
        acknowledged: 0,
        resolved: 0,
        missed: 0,
        byReason: {
            request_bill: 0,
            assistance: 0,
            emergency: 0,
            other: 0,
        },
        avgResponseTimeSeconds: 0,
        avgResolutionTimeSeconds: 0,
    })
})
