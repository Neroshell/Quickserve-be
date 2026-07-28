import { DateTime } from "luxon"
import Order from "../../models/order.js"
import ServicePoint from "../../models/ServicePoint.js"
import ServiceRequest from "../../models/ServiceRequest.js"

function createStats() {
    return {
        todayRevenue: 0,
        yesterdayRevenue: 0,
        weekRevenue: 0,
        monthRevenue: 0,
        activeOrders: 0,
        completedToday: 0,
        averageOrderValue: 0,
        previousAverageOrderValue: 0,
        totalItemsSold: 0,
        peakHour: "N/A",
        averagePrepTime: 0,
        dineInCount: 0,
        takeoutCount: 0,
        customerOrderCount: 0,
        staffOrderCount: 0,
        customerRevenue: 0,
        staffRevenue: 0,
        totalTipsCollected: 0,
        averageTip: 0,
        highestTip: 0,
        ordersWithTips: 0,
        tipRate: 0,
    }
}

function createHourlyOrdersMap() {
    const hourlyOrdersMap = new Map()
    for (let i = 0; i < 24; i++) {
        const hour = i > 12 ? i - 12 : i === 0 ? 12 : i
        const suffix = i >= 12 ? "PM" : "AM"
        hourlyOrdersMap.set(`${hour}${suffix}`, { orders: 0, revenue: 0 })
    }
    return hourlyOrdersMap
}

function getServiceCallAggregation({ businessId, startDate, endDate }) {
    return [
        {
            $match: {
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
            },
        },
        {
            $facet: {
                byStatus: [
                    { $group: { _id: "$status", count: { $sum: 1 } } },
                ],
                byReason: [
                    { $group: { _id: "$reason", count: { $sum: 1 } } },
                ],
                responseTimes: [
                    { $match: { acknowledgedAt: { $ne: null } } },
                    {
                        $project: {
                            responseTimeSeconds: {
                                $divide: [
                                    {
                                        $subtract: [
                                            "$acknowledgedAt",
                                            "$createdAt",
                                        ],
                                    },
                                    1000,
                                ],
                            },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: "$responseTimeSeconds" },
                        },
                    },
                ],
                resolutionTimes: [
                    {
                        $match: {
                            resolvedAt: { $ne: null },
                            status: "resolved",
                        },
                    },
                    {
                        $project: {
                            resolutionTimeSeconds: {
                                $divide: [
                                    {
                                        $subtract: [
                                            "$resolvedAt",
                                            "$createdAt",
                                        ],
                                    },
                                    1000,
                                ],
                            },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: "$resolutionTimeSeconds" },
                        },
                    },
                ],
            },
        },
    ]
}

function getServicePointPerformanceAggregation({
    businessId,
    startDate,
    endDate,
}) {
    return [
        {
            $match: {
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
                status: {
                    $in: ["placed", "in_progress", "ready", "completed"],
                },
            },
        },
        {
            $group: {
                _id: "$servicePointLabel",
                label: { $first: "$servicePointLabel" },
                orderCount: { $sum: 1 },
                totalRevenue: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ["$total", 0] },
                            { $ifNull: ["$tipAmount", 0] },
                        ],
                    },
                },
                paidOrders: {
                    $sum: {
                        $cond: [
                            { $eq: ["$paymentStatus", "paid"] },
                            1,
                            0,
                        ],
                    },
                },
                unpaidOrders: {
                    $sum: {
                        $cond: [
                            { $ne: ["$paymentStatus", "paid"] },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
        { $sort: { orderCount: -1, totalRevenue: -1 } },
    ]
}

function getWaitstaffCallAggregation({ businessId, startDate, endDate }) {
    return [
        {
            $match: {
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
            },
        },
        {
            $facet: {
                acknowledged: [
                    {
                        $match: {
                            acknowledgedByStaffId: { $ne: null },
                        },
                    },
                    {
                        $group: {
                            _id: "$acknowledgedByStaffId",
                            name: { $first: "$acknowledgedByName" },
                            count: { $sum: 1 },
                            totalRespMs: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                {
                                                    $ne: [
                                                        "$acknowledgedAt",
                                                        null,
                                                    ],
                                                },
                                                {
                                                    $ne: ["$createdAt", null],
                                                },
                                            ],
                                        },
                                        {
                                            $subtract: [
                                                "$acknowledgedAt",
                                                "$createdAt",
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                            respCount: {
                                $sum: {
                                    $cond: [
                                        {
                                            $ne: [
                                                "$acknowledgedAt",
                                                null,
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
                resolved: [
                    {
                        $match: {
                            resolvedByStaffId: { $ne: null },
                        },
                    },
                    {
                        $group: {
                            _id: "$resolvedByStaffId",
                            name: { $first: "$resolvedByName" },
                            count: { $sum: 1 },
                            totalResolMs: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                {
                                                    $ne: [
                                                        "$resolvedAt",
                                                        null,
                                                    ],
                                                },
                                                {
                                                    $ne: ["$createdAt", null],
                                                },
                                            ],
                                        },
                                        {
                                            $subtract: [
                                                "$resolvedAt",
                                                "$createdAt",
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                            resolCount: {
                                $sum: {
                                    $cond: [
                                        {
                                            $ne: ["$resolvedAt", null],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
            },
        },
    ]
}

function getPaymentStaffAggregation({ businessId, startDate, endDate }) {
    return [
        {
            $match: {
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
                paidByStaffId: { $ne: null },
                paymentStatus: "paid",
            },
        },
        {
            $group: {
                _id: "$paidByStaffId",
                name: { $first: "$paidByName" },
                paymentsConfirmed: { $sum: 1 },
                totalOfflinePaymentsConfirmed: {
                    $sum: {
                        $cond: [
                            { $eq: ["$paymentChannel", "offline"] },
                            {
                                $subtract: [
                                    { $ifNull: ["$total", 0] },
                                    { $ifNull: ["$tipAmount", 0] },
                                ],
                            },
                            0,
                        ],
                    },
                },
            },
        },
    ]
}

function getServedStaffAggregation({ businessId, startDate, endDate }) {
    return [
        {
            $match: {
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
                servedByStaffId: { $ne: null },
                status: "completed",
            },
        },
        {
            $group: {
                _id: "$servedByStaffId",
                name: { $first: "$servedByName" },
                ordersServed: { $sum: 1 },
            },
        },
    ]
}

function shapeServiceCalls(serviceCallsAggregation) {
    const facet = serviceCallsAggregation?.[0] || {}
    const byStatus = {}
    for (const row of facet.byStatus || []) {
        if (row._id) byStatus[row._id] = row.count
    }

    const knownReasons = ["request_bill", "assistance", "emergency"]
    const byReason = {
        request_bill: 0,
        assistance: 0,
        emergency: 0,
        other: 0,
    }
    for (const row of facet.byReason || []) {
        const key = (row._id || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "_")
        if (knownReasons.includes(key)) {
            byReason[key] += row.count
        } else {
            byReason.other += row.count
        }
    }

    return {
        total:
            (byStatus.pending || 0) +
            (byStatus.acknowledged || 0) +
            (byStatus.resolved || 0) +
            (byStatus.missed || 0),
        pending: byStatus.pending || 0,
        acknowledged: byStatus.acknowledged || 0,
        resolved: byStatus.resolved || 0,
        missed: byStatus.missed || 0,
        byReason,
        avgResponseTimeSeconds: Math.round(
            facet.responseTimes?.[0]?.avg || 0
        ),
        avgResolutionTimeSeconds: Math.round(
            facet.resolutionTimes?.[0]?.avg || 0
        ),
    }
}

async function shapeServicePointPerformance({
    rows,
    businessId,
    servicePointModel,
}) {
    const servicePointIds = rows
        .map((row) => row._id)
        .filter(
            (id) => typeof id === "string" && id.startsWith("sp_")
        )

    const servicePoints =
        servicePointIds.length > 0
            ? await servicePointModel
                  .find(
                      {
                          servicePointId: { $in: servicePointIds },
                          businessId,
                      },
                      "servicePointId label code servicePointType"
                  )
                  .lean()
            : []

    const servicePointMap = {}
    for (const servicePoint of servicePoints) {
        servicePointMap[servicePoint.servicePointId] = servicePoint
    }

    return rows.map((row) => {
        const servicePoint = servicePointMap[row._id]
        const revenue = row.totalRevenue || 0
        const count = row.orderCount || 0
        return {
            servicePointId: row._id || "",
            label:
                servicePoint?.label ||
                row.label ||
                row._id ||
                "Unknown",
            code: servicePoint?.code || "",
            servicePointType:
                servicePoint?.servicePointType || "table",
            orderCount: count,
            totalRevenue: +revenue.toFixed(2),
            averageOrderValue:
                count > 0 ? +(revenue / count).toFixed(2) : 0,
            paidOrders: row.paidOrders || 0,
            unpaidOrders: row.unpaidOrders || 0,
        }
    })
}

function shapeWaitstaffPerformance({
    waiterCallStaffAggregation,
    paymentStaffAggregation,
    servedStaffAggregation,
}) {
    const staffMap = {}

    function ensureStaff(id, name) {
        if (!id) return
        if (!staffMap[id]) {
            staffMap[id] = {
                staffId: id,
                name: name || "Unknown Staff",
                callsAcknowledged: 0,
                callsResolved: 0,
                totalRespMs: 0,
                respCount: 0,
                totalResolMs: 0,
                resolCount: 0,
                ordersServed: 0,
                paymentsConfirmed: 0,
                totalOfflinePaymentsConfirmed: 0,
            }
        }
        if (name && staffMap[id].name === "Unknown Staff") {
            staffMap[id].name = name
        }
    }

    const waiterFacet = waiterCallStaffAggregation?.[0] || {}
    for (const row of waiterFacet.acknowledged || []) {
        ensureStaff(row._id, row.name)
        const staff = staffMap[row._id]
        staff.callsAcknowledged += row.count || 0
        staff.totalRespMs += row.totalRespMs || 0
        staff.respCount += row.respCount || 0
    }
    for (const row of waiterFacet.resolved || []) {
        ensureStaff(row._id, row.name)
        const staff = staffMap[row._id]
        staff.callsResolved += row.count || 0
        staff.totalResolMs += row.totalResolMs || 0
        staff.resolCount += row.resolCount || 0
    }
    for (const row of paymentStaffAggregation || []) {
        ensureStaff(row._id, row.name)
        const staff = staffMap[row._id]
        staff.paymentsConfirmed += row.paymentsConfirmed || 0
        staff.totalOfflinePaymentsConfirmed +=
            row.totalOfflinePaymentsConfirmed || 0
    }
    for (const row of servedStaffAggregation || []) {
        ensureStaff(row._id, row.name)
        staffMap[row._id].ordersServed += row.ordersServed || 0
    }

    return Object.values(staffMap)
        .map((staff) => ({
            staffId: staff.staffId,
            name: staff.name,
            callsAcknowledged: staff.callsAcknowledged,
            callsResolved: staff.callsResolved,
            avgResponseTimeSeconds:
                staff.respCount > 0
                    ? Math.round(
                          staff.totalRespMs / staff.respCount / 1000
                      )
                    : 0,
            avgResolutionTimeSeconds:
                staff.resolCount > 0
                    ? Math.round(
                          staff.totalResolMs /
                              staff.resolCount /
                              1000
                      )
                    : 0,
            ordersServed: staff.ordersServed,
            paymentsConfirmed: staff.paymentsConfirmed,
            totalOfflinePaymentsConfirmed:
                +staff.totalOfflinePaymentsConfirmed.toFixed(2),
        }))
        .sort(
            (first, second) =>
                second.callsResolved - first.callsResolved ||
                second.paymentsConfirmed - first.paymentsConfirmed
        )
}

/**
 * Build the legacy flat food-service analytics DTO.
 *
 * Phase 1 intentionally preserves the calculations and response field names
 * previously owned by ownerController.ownerAnalytics.
 */
export async function getFoodServiceAnalytics({
    businessId,
    analyticsRange,
    orderModel = Order,
    serviceRequestModel = ServiceRequest,
    servicePointModel = ServicePoint,
}) {
    const {
        preset,
        startDate,
        endDate,
        from,
        to,
        timezone,
    } = analyticsRange

    const queryContext = {
        businessId,
        startDate,
        endDate,
    }

    const [
        orders,
        serviceCallsAggregation,
        servicePointAggregation,
        waiterCallStaffAggregation,
        paymentStaffAggregation,
        servedStaffAggregation,
    ] = await Promise.all([
        orderModel
            .find({
                businessId,
                createdAt: { $gte: startDate, $lt: endDate },
            })
            .lean(),
        serviceRequestModel.aggregate(
            getServiceCallAggregation(queryContext)
        ),
        orderModel.aggregate(
            getServicePointPerformanceAggregation(queryContext)
        ),
        serviceRequestModel.aggregate(
            getWaitstaffCallAggregation(queryContext)
        ),
        orderModel.aggregate(
            getPaymentStaffAggregation(queryContext)
        ),
        orderModel.aggregate(getServedStaffAggregation(queryContext)),
    ])

    const stats = createStats()
    const hourlyOrdersMap = createHourlyOrdersMap()
    const revenueByDayMap = new Map()
    const itemsMap = new Map()
    const categoryMap = new Map()
    let totalPrepTimeMinutes = 0
    let prepTimeCount = 0
    let totalPaidOrders = 0

    const isSingleDay =
        preset === "today" ||
        preset === "yesterday" ||
        (preset === "custom" && from === to)

    if (!isSingleDay) {
        let current = DateTime.fromJSDate(startDate).setZone(timezone)
        const end = DateTime.fromJSDate(endDate).setZone(timezone)
        while (current < end) {
            const label =
                preset === "7days"
                    ? current.toFormat("ccc")
                    : current.toFormat("MMM dd")
            revenueByDayMap.set(label, {
                revenue: 0,
                orders: 0,
                dateRaw: current.toISODate(),
            })
            current = current.plus({ days: 1 })
        }
    }

    let totalRevenue = 0
    let totalTipsCollected = 0
    let highestTip = 0
    let ordersWithTips = 0

    for (const order of orders) {
        const orderDate = DateTime.fromJSDate(order.createdAt).setZone(
            timezone
        )
        const hourLabel = `${orderDate.toFormat("h")}${orderDate.toFormat(
            "a"
        )}`

        if (hourlyOrdersMap.has(hourLabel)) {
            hourlyOrdersMap.get(hourLabel).orders += 1
        }

        // Preserve the current Phase 1 status behavior, including cancelled
        // orders being treated by this historical rule as active.
        if (order.status !== "completed" && order.status !== "ready") {
            stats.activeOrders++
        }
        if (order.status === "completed") {
            stats.completedToday++
        }

        if (order.orderType === "dine-in") stats.dineInCount++
        if (order.orderType === "takeout") stats.takeoutCount++

        if (order.orderSource === "waitstaff") {
            stats.staffOrderCount++
        } else {
            stats.customerOrderCount++
        }

        const prepEndTime = order.readyAt || order.completedAt
        if (order.createdAt && prepEndTime) {
            const prepMinutes = DateTime.fromJSDate(prepEndTime).diff(
                DateTime.fromJSDate(order.createdAt),
                "minutes"
            ).minutes
            if (prepMinutes > 0 && prepMinutes < 300) {
                totalPrepTimeMinutes += prepMinutes
                prepTimeCount++
            }
        }

        if (order.paymentStatus !== "paid") continue

        const tipValue = Number(order.tipAmount || 0)
        const revenueValue = Number(
            ((order.total || 0) - tipValue).toFixed(2)
        )
        totalRevenue += revenueValue
        totalTipsCollected += tipValue
        if (tipValue > 0) {
            ordersWithTips++
            highestTip = Math.max(highestTip, tipValue)
        }
        totalPaidOrders++

        if (hourlyOrdersMap.has(hourLabel)) {
            hourlyOrdersMap.get(hourLabel).revenue += revenueValue
        }

        if (order.orderSource === "waitstaff") {
            stats.staffRevenue += revenueValue
        } else {
            stats.customerRevenue += revenueValue
        }

        if (!isSingleDay) {
            const label =
                preset === "7days"
                    ? orderDate.toFormat("ccc")
                    : orderDate.toFormat("MMM dd")
            if (revenueByDayMap.has(label)) {
                const dayStats = revenueByDayMap.get(label)
                dayStats.revenue += revenueValue
                dayStats.orders += 1
            }
        }

        for (const item of order.items || []) {
            stats.totalItemsSold += item.quantity

            if (!itemsMap.has(item.itemName)) {
                itemsMap.set(item.itemName, {
                    quantity: 0,
                    revenue: 0,
                    category: item.category || "food",
                })
            }
            const trackedItem = itemsMap.get(item.itemName)
            trackedItem.quantity += item.quantity
            trackedItem.revenue += item.lineTotal || 0

            const category = item.category || "food"
            if (!categoryMap.has(category)) {
                categoryMap.set(category, { revenue: 0, quantity: 0 })
            }
            categoryMap.get(category).revenue += item.lineTotal || 0
            categoryMap.get(category).quantity += item.quantity
        }
    }

    stats.todayRevenue = totalRevenue
    stats.yesterdayRevenue = 0
    stats.weekRevenue = totalRevenue
    stats.monthRevenue = totalRevenue
    stats.averageOrderValue =
        totalPaidOrders > 0 ? totalRevenue / totalPaidOrders : 0
    stats.totalTipsCollected = +totalTipsCollected.toFixed(2)
    stats.averageTip =
        ordersWithTips > 0
            ? +(totalTipsCollected / ordersWithTips).toFixed(2)
            : 0
    stats.highestTip = +highestTip.toFixed(2)
    stats.ordersWithTips = ordersWithTips
    stats.tipRate =
        totalPaidOrders > 0
            ? Math.round((ordersWithTips / totalPaidOrders) * 100)
            : 0
    stats.averagePrepTime =
        prepTimeCount > 0
            ? Math.round(totalPrepTimeMinutes / prepTimeCount)
            : 0

    let maxOrders = 0
    for (const [hour, data] of hourlyOrdersMap.entries()) {
        if (data.orders > maxOrders) {
            maxOrders = data.orders
            stats.peakHour = hour
        }
    }

    const hourlyOrders = Array.from(hourlyOrdersMap.entries()).map(
        ([hour, data]) => ({
            hour,
            orders: data.orders,
            revenue: data.revenue,
        })
    )

    const revenueByDay = isSingleDay
        ? hourlyOrders.map((hour) => ({
              date: hour.hour,
              revenue: hour.revenue,
              orders: hour.orders,
          }))
        : Array.from(revenueByDayMap.entries()).map(([date, data]) => ({
              date,
              revenue: data.revenue,
              orders: data.orders,
          }))

    const topItems = Array.from(itemsMap.entries())
        .map(([itemName, data]) => ({
            itemName,
            quantity: data.quantity,
            revenue: data.revenue,
            category: data.category,
        }))
        .sort((first, second) => second.quantity - first.quantity)
        .slice(0, 5)

    const categoryPerformance = Array.from(categoryMap.entries())
        .map(([category, data]) => ({
            category:
                category.charAt(0).toUpperCase() + category.slice(1),
            revenue: data.revenue,
            quantity: data.quantity,
            percentage:
                totalRevenue > 0
                    ? Math.round((data.revenue / totalRevenue) * 100)
                    : 0,
        }))
        .sort(
            (first, second) => second.percentage - first.percentage
        )

    const totalTypedOrders = stats.dineInCount + stats.takeoutCount
    let dineInRevenue = 0
    let takeoutRevenue = 0
    for (const order of orders) {
        if (order.paymentStatus !== "paid") continue
        const revenueValue = Number(
            (
                (order.total || 0) -
                Number(order.tipAmount || 0)
            ).toFixed(2)
        )
        if (order.orderType === "dine-in") {
            dineInRevenue += revenueValue
        }
        if (order.orderType === "takeout") {
            takeoutRevenue += revenueValue
        }
    }

    const orderTypeBreakdown = [
        {
            type: "dine-in",
            count: stats.dineInCount,
            revenue: dineInRevenue,
            percentage:
                totalTypedOrders > 0
                    ? Math.round(
                          (stats.dineInCount / totalTypedOrders) * 100
                      )
                    : 0,
        },
        {
            type: "takeout",
            count: stats.takeoutCount,
            revenue: takeoutRevenue,
            percentage:
                totalTypedOrders > 0
                    ? Math.round(
                          (stats.takeoutCount / totalTypedOrders) * 100
                      )
                    : 0,
        },
    ]

    const totalChannelOrders =
        stats.customerOrderCount + stats.staffOrderCount
    const totalChannelRevenue =
        stats.customerRevenue + stats.staffRevenue
    const channelBreakdown = [
        {
            channel: "self",
            label: "Self Ordering",
            count: stats.customerOrderCount,
            revenue: stats.customerRevenue,
            orderPercentage:
                totalChannelOrders > 0
                    ? Math.round(
                          (stats.customerOrderCount /
                              totalChannelOrders) *
                              100
                      )
                    : 0,
            revenuePercentage:
                totalChannelRevenue > 0
                    ? Math.round(
                          (stats.customerRevenue /
                              totalChannelRevenue) *
                              100
                      )
                    : 0,
        },
        {
            channel: "waitstaff",
            label: "Staff-Assisted Ordering",
            count: stats.staffOrderCount,
            revenue: stats.staffRevenue,
            orderPercentage:
                totalChannelOrders > 0
                    ? Math.round(
                          (stats.staffOrderCount / totalChannelOrders) *
                              100
                      )
                    : 0,
            revenuePercentage:
                totalChannelRevenue > 0
                    ? Math.round(
                          (stats.staffRevenue /
                              totalChannelRevenue) *
                              100
                      )
                    : 0,
        },
    ]

    const serviceCalls = shapeServiceCalls(serviceCallsAggregation)
    const tablePerformance = await shapeServicePointPerformance({
        rows: servicePointAggregation,
        businessId,
        servicePointModel,
    })
    const waitstaffPerformance = shapeWaitstaffPerformance({
        waiterCallStaffAggregation,
        paymentStaffAggregation,
        servedStaffAggregation,
    })

    return {
        stats,
        revenueByDay,
        hourlyOrders,
        topItems,
        categoryPerformance,
        orderTypeBreakdown,
        channelBreakdown,
        serviceCalls,
        tablePerformance,
        waitstaffPerformance,
    }
}
