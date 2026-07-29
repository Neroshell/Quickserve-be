import Order from "../../models/order.js"
import ServicePoint from "../../models/ServicePoint.js"
import ServiceRequest from "../../models/ServiceRequest.js"
import { buildOrderAnalyticsFinancialFields } from "./sharedAnalyticsService.js"

export const FOOD_SERVICE_ACTIVE_STATUSES = Object.freeze([
    "placed",
    "in_progress",
    "ready",
])
export const FOOD_SERVICE_COMPLETED_STATUSES = Object.freeze([
    "completed",
])
export const FOOD_SERVICE_PERFORMANCE_STATUSES = Object.freeze([
    ...FOOD_SERVICE_ACTIVE_STATUSES,
    ...FOOD_SERVICE_COMPLETED_STATUSES,
])

function currentCreatedAtMatch(analyticsRange) {
    return {
        createdAt: {
            $gte: analyticsRange.startUtc,
            $lt: analyticsRange.endUtcExclusive,
        },
    }
}

function currentPaidAtMatch(analyticsRange) {
    return {
        analyticsPaidAt: {
            $gte: analyticsRange.startUtc,
            $lt: analyticsRange.endUtcExclusive,
        },
        paymentStatus: "paid",
        status: { $ne: "cancelled" },
    }
}

function prepMinutesExpression() {
    return {
        $let: {
            vars: {
                prepEnd: {
                    $ifNull: ["$readyAt", "$completedAt"],
                },
            },
            in: {
                $cond: [
                    {
                        $and: [
                            { $ne: ["$$prepEnd", null] },
                            { $ne: ["$createdAt", null] },
                        ],
                    },
                    {
                        $divide: [
                            {
                                $subtract: [
                                    "$$prepEnd",
                                    "$createdAt",
                                ],
                            },
                            60000,
                        ],
                    },
                    null,
                ],
            },
        },
    }
}

function buildFoodServiceOrderPipeline({
    businessId,
    analyticsRange,
}) {
    const createdAtMatch = currentCreatedAtMatch(analyticsRange)
    const paidAtMatch = currentPaidAtMatch(analyticsRange)

    return [
        {
            $match: {
                businessId,
                $or: [
                    createdAtMatch,
                    {
                        paymentStatus: "paid",
                        paidAt: {
                            $gte: analyticsRange.startUtc,
                            $lt: analyticsRange.endUtcExclusive,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                ...buildOrderAnalyticsFinancialFields(),
                analyticsPrepMinutes: prepMinutesExpression(),
            },
        },
        {
            $facet: {
                overview: [
                    { $match: createdAtMatch },
                    {
                        $group: {
                            _id: null,
                            activeOrders: {
                                $sum: {
                                    $cond: [
                                        {
                                            $in: [
                                                "$status",
                                                FOOD_SERVICE_ACTIVE_STATUSES,
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            completedOrders: {
                                $sum: {
                                    $cond: [
                                        {
                                            $in: [
                                                "$status",
                                                FOOD_SERVICE_COMPLETED_STATUSES,
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            totalPrepMinutes: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                {
                                                    $gt: [
                                                        "$analyticsPrepMinutes",
                                                        0,
                                                    ],
                                                },
                                                {
                                                    $lt: [
                                                        "$analyticsPrepMinutes",
                                                        300,
                                                    ],
                                                },
                                            ],
                                        },
                                        "$analyticsPrepMinutes",
                                        0,
                                    ],
                                },
                            },
                            prepTimeCount: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                {
                                                    $gt: [
                                                        "$analyticsPrepMinutes",
                                                        0,
                                                    ],
                                                },
                                                {
                                                    $lt: [
                                                        "$analyticsPrepMinutes",
                                                        300,
                                                    ],
                                                },
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
                peakOrderHour: [
                    {
                        $match: {
                            ...createdAtMatch,
                            status: {
                                $in: FOOD_SERVICE_PERFORMANCE_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $hour: {
                                    date: "$createdAt",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            orderCount: { $sum: 1 },
                        },
                    },
                    { $sort: { orderCount: -1, _id: 1 } },
                    { $limit: 1 },
                ],
                hourlyOrders: [
                    {
                        $match: {
                            ...createdAtMatch,
                            status: {
                                $in: FOOD_SERVICE_PERFORMANCE_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $hour: {
                                    date: "$createdAt",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            orderCount: { $sum: 1 },
                            paidRevenueCents: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                "$paymentStatus",
                                                "paid",
                                            ],
                                        },
                                        "$analyticsGrossCents",
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
                totalItemsSold: [
                    { $match: paidAtMatch },
                    { $unwind: "$items" },
                    {
                        $group: {
                            _id: null,
                            quantity: {
                                $sum: {
                                    $ifNull: [
                                        "$items.quantity",
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
                topItems: [
                    { $match: paidAtMatch },
                    { $unwind: "$items" },
                    {
                        $group: {
                            _id: "$items.itemName",
                            quantity: {
                                $sum: {
                                    $ifNull: [
                                        "$items.quantity",
                                        0,
                                    ],
                                },
                            },
                            paidItemRevenueCents: {
                                $sum: {
                                    $round: [
                                        {
                                            $multiply: [
                                                {
                                                    $ifNull: [
                                                        "$items.lineTotal",
                                                        0,
                                                    ],
                                                },
                                                100,
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                            category: {
                                $first: {
                                    $ifNull: [
                                        "$items.category",
                                        "uncategorized",
                                    ],
                                },
                            },
                        },
                    },
                    { $sort: { quantity: -1, _id: 1 } },
                    { $limit: 5 },
                ],
                categoryPerformance: [
                    { $match: paidAtMatch },
                    { $unwind: "$items" },
                    {
                        $group: {
                            _id: {
                                $ifNull: [
                                    "$items.category",
                                    "uncategorized",
                                ],
                            },
                            quantity: {
                                $sum: {
                                    $ifNull: [
                                        "$items.quantity",
                                        0,
                                    ],
                                },
                            },
                            paidItemRevenueCents: {
                                $sum: {
                                    $round: [
                                        {
                                            $multiply: [
                                                {
                                                    $ifNull: [
                                                        "$items.lineTotal",
                                                        0,
                                                    ],
                                                },
                                                100,
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    {
                        $sort: {
                            paidItemRevenueCents: -1,
                            _id: 1,
                        },
                    },
                ],
                orderTypeCounts: [
                    {
                        $match: {
                            ...createdAtMatch,
                            status: {
                                $in: FOOD_SERVICE_PERFORMANCE_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$orderType",
                            orderCount: { $sum: 1 },
                        },
                    },
                ],
                orderTypeRevenue: [
                    { $match: paidAtMatch },
                    {
                        $group: {
                            _id: "$orderType",
                            paidRevenueCents: {
                                $sum: "$analyticsGrossCents",
                            },
                        },
                    },
                ],
                channelCounts: [
                    {
                        $match: {
                            ...createdAtMatch,
                            status: {
                                $in: FOOD_SERVICE_PERFORMANCE_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$orderSource",
                            orderCount: { $sum: 1 },
                        },
                    },
                ],
                channelRevenue: [
                    { $match: paidAtMatch },
                    {
                        $group: {
                            _id: "$orderSource",
                            paidRevenueCents: {
                                $sum: "$analyticsGrossCents",
                            },
                        },
                    },
                ],
                servicePointPerformance: [
                    {
                        $match: {
                            ...createdAtMatch,
                            status: {
                                $in: FOOD_SERVICE_PERFORMANCE_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$servicePointLabel",
                            displayLabel: {
                                $first: "$displayLabel",
                            },
                            orderCount: { $sum: 1 },
                            paidOrders: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                "$paymentStatus",
                                                "paid",
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            unpaidOrders: {
                                $sum: {
                                    $cond: [
                                        {
                                            $ne: [
                                                "$paymentStatus",
                                                "paid",
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            paidRevenueCents: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                "$paymentStatus",
                                                "paid",
                                            ],
                                        },
                                        "$analyticsGrossCents",
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    {
                        $sort: {
                            orderCount: -1,
                            paidRevenueCents: -1,
                        },
                    },
                ],
                paymentStaff: [
                    {
                        $match: {
                            ...paidAtMatch,
                            paidByStaffId: { $ne: null },
                            paymentChannel: "offline",
                        },
                    },
                    {
                        $group: {
                            _id: "$paidByStaffId",
                            name: { $first: "$paidByName" },
                            paymentsConfirmed: { $sum: 1 },
                            totalOfflinePaymentsConfirmedCents: {
                                $sum: "$analyticsGrossCents",
                            },
                        },
                    },
                ],
                servedStaff: [
                    {
                        $match: {
                            ...createdAtMatch,
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
                ],
            },
        },
    ]
}

function buildServiceRequestPipeline({
    businessId,
    analyticsRange,
}) {
    const createdAt = {
        $gte: analyticsRange.startUtc,
        $lt: analyticsRange.endUtcExclusive,
    }

    return [
        {
            $match: {
                businessId,
                module: "foodService",
                createdAt,
            },
        },
        {
            $facet: {
                byStatus: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: "$status",
                            count: { $sum: 1 },
                        },
                    },
                ],
                byReason: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: {
                                $ifNull: [
                                    "$requestCategory",
                                    "$reason",
                                ],
                            },
                            count: { $sum: 1 },
                        },
                    },
                ],
                responseTimes: [
                    {
                        $match: {
                            createdAt,
                            acknowledgedAt: { $ne: null },
                        },
                    },
                    {
                        $project: {
                            seconds: {
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
                            average: { $avg: "$seconds" },
                        },
                    },
                ],
                resolutionTimes: [
                    {
                        $match: {
                            createdAt,
                            resolvedAt: { $ne: null },
                            status: "resolved",
                        },
                    },
                    {
                        $project: {
                            seconds: {
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
                            average: { $avg: "$seconds" },
                        },
                    },
                ],
                acknowledgedStaff: [
                    {
                        $match: {
                            createdAt,
                            acknowledgedByStaffId: { $ne: null },
                        },
                    },
                    {
                        $group: {
                            _id: "$acknowledgedByStaffId",
                            name: {
                                $first: "$acknowledgedByName",
                            },
                            count: { $sum: 1 },
                            totalResponseMilliseconds: {
                                $sum: {
                                    $cond: [
                                        {
                                            $ne: [
                                                "$acknowledgedAt",
                                                null,
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
                            responseCount: {
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
                resolvedStaff: [
                    {
                        $match: {
                            createdAt,
                            resolvedByStaffId: { $ne: null },
                        },
                    },
                    {
                        $group: {
                            _id: "$resolvedByStaffId",
                            name: { $first: "$resolvedByName" },
                            count: { $sum: 1 },
                            totalResolutionMilliseconds: {
                                $sum: {
                                    $cond: [
                                        {
                                            $ne: [
                                                "$resolvedAt",
                                                null,
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
                            resolutionCount: {
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

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.round(number) : 0
}

function hourLabel(hourIndex) {
    const hour = hourIndex > 12
        ? hourIndex - 12
        : hourIndex === 0
          ? 12
          : hourIndex
    return `${hour}${hourIndex >= 12 ? "PM" : "AM"}`
}

function shapeHourlyOrders(rows) {
    const byHour = new Map(
        (rows || []).map((row) => [
            Number(row._id),
            {
                orderCount: integer(row.orderCount),
                paidRevenueCents: integer(
                    row.paidRevenueCents
                ),
            },
        ])
    )

    return Array.from({ length: 24 }, (_, hourIndex) => ({
        hour: hourLabel(hourIndex),
        orderCount: byHour.get(hourIndex)?.orderCount || 0,
        paidRevenueCents:
            byHour.get(hourIndex)?.paidRevenueCents || 0,
    }))
}

function percentage(part, total) {
    return total > 0
        ? Math.round((part / total) * 1000) / 10
        : 0
}

function shapeBreakdown({
    ids,
    labels,
    countRows,
    revenueRows,
    idField,
}) {
    const counts = new Map(
        (countRows || []).map((row) => [
            row._id,
            integer(row.orderCount),
        ])
    )
    const revenues = new Map(
        (revenueRows || []).map((row) => [
            row._id,
            integer(row.paidRevenueCents),
        ])
    )
    const totalOrders = ids.reduce(
        (sum, id) => sum + (counts.get(id) || 0),
        0
    )
    const totalRevenue = ids.reduce(
        (sum, id) => sum + (revenues.get(id) || 0),
        0
    )

    return ids.map((id) => ({
        [idField]: id,
        ...(labels ? { label: labels[id] } : {}),
        orderCount: counts.get(id) || 0,
        paidRevenueCents: revenues.get(id) || 0,
        orderPercentage: percentage(
            counts.get(id) || 0,
            totalOrders
        ),
        revenuePercentage: percentage(
            revenues.get(id) || 0,
            totalRevenue
        ),
    }))
}

function shapeCategoryPerformance(rows) {
    const totalItemRevenueCents = (rows || []).reduce(
        (sum, row) => sum + integer(row.paidItemRevenueCents),
        0
    )

    return (rows || []).map((row) => {
        const paidItemRevenueCents = integer(
            row.paidItemRevenueCents
        )
        const rawCategory = row._id || "uncategorized"
        return {
            category:
                rawCategory.charAt(0).toUpperCase() +
                rawCategory.slice(1),
            quantity: integer(row.quantity),
            paidItemRevenueCents,
            percentageOfItemRevenue: percentage(
                paidItemRevenueCents,
                totalItemRevenueCents
            ),
        }
    })
}

async function shapeServicePointPerformance({
    rows,
    businessId,
    servicePointModel,
}) {
    const servicePointIds = (rows || [])
        .map((row) => row._id)
        .filter(
            (id) => typeof id === "string" && id.startsWith("sp_")
        )
    const servicePoints =
        servicePointIds.length > 0
            ? await servicePointModel
                  .find(
                      {
                          businessId,
                          servicePointId: {
                              $in: servicePointIds,
                          },
                      },
                      "servicePointId label code servicePointType"
                  )
                  .lean()
            : []
    const metadata = new Map(
        servicePoints.map((servicePoint) => [
            servicePoint.servicePointId,
            servicePoint,
        ])
    )

    return (rows || []).map((row) => {
        const servicePoint = metadata.get(row._id)
        const paidOrders = integer(row.paidOrders)
        const paidRevenueCents = integer(row.paidRevenueCents)
        return {
            servicePointId: row._id || "",
            label:
                servicePoint?.label ||
                row.displayLabel ||
                row._id ||
                "Unknown",
            code: servicePoint?.code || "",
            servicePointType:
                servicePoint?.servicePointType || "table",
            orderCount: integer(row.orderCount),
            paidOrders,
            unpaidOrders: integer(row.unpaidOrders),
            paidRevenueCents,
            averagePaidOrderValueCents:
                paidOrders > 0
                    ? Math.round(
                          paidRevenueCents / paidOrders
                      )
                    : 0,
        }
    })
}

function shapeServiceRequests(facet) {
    const statuses = new Map(
        (facet.byStatus || []).map((row) => [
            row._id,
            integer(row.count),
        ])
    )
    const byReason = {
        request_bill: 0,
        assistance: 0,
        emergency: 0,
        other: 0,
    }
    for (const row of facet.byReason || []) {
        const reason = String(row._id || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "_")
        const target = Object.hasOwn(byReason, reason)
            ? reason
            : "other"
        byReason[target] += integer(row.count)
    }

    return {
        total:
            (statuses.get("pending") || 0) +
            (statuses.get("acknowledged") || 0) +
            (statuses.get("resolved") || 0) +
            (statuses.get("missed") || 0),
        pending: statuses.get("pending") || 0,
        acknowledged: statuses.get("acknowledged") || 0,
        resolved: statuses.get("resolved") || 0,
        missed: statuses.get("missed") || 0,
        byReason,
        averageResponseTimeSeconds: integer(
            facet.responseTimes?.[0]?.average
        ),
        averageResolutionTimeSeconds: integer(
            facet.resolutionTimes?.[0]?.average
        ),
    }
}

function shapeStaffPerformance({
    serviceRequestFacet,
    orderFacet,
}) {
    const staff = new Map()

    function ensure(id, name) {
        if (!id) return null
        if (!staff.has(id)) {
            staff.set(id, {
                staffId: id,
                name: name || "Unknown Staff",
                callsAcknowledged: 0,
                callsResolved: 0,
                totalResponseMilliseconds: 0,
                responseCount: 0,
                totalResolutionMilliseconds: 0,
                resolutionCount: 0,
                ordersServed: 0,
                paymentsConfirmed: 0,
                totalOfflinePaymentsConfirmedCents: 0,
            })
        }
        const current = staff.get(id)
        if (name && current.name === "Unknown Staff") {
            current.name = name
        }
        return current
    }

    for (const row of serviceRequestFacet.acknowledgedStaff || []) {
        const current = ensure(row._id, row.name)
        current.callsAcknowledged += integer(row.count)
        current.totalResponseMilliseconds += integer(
            row.totalResponseMilliseconds
        )
        current.responseCount += integer(row.responseCount)
    }
    for (const row of serviceRequestFacet.resolvedStaff || []) {
        const current = ensure(row._id, row.name)
        current.callsResolved += integer(row.count)
        current.totalResolutionMilliseconds += integer(
            row.totalResolutionMilliseconds
        )
        current.resolutionCount += integer(row.resolutionCount)
    }
    for (const row of orderFacet.paymentStaff || []) {
        const current = ensure(row._id, row.name)
        current.paymentsConfirmed += integer(
            row.paymentsConfirmed
        )
        current.totalOfflinePaymentsConfirmedCents += integer(
            row.totalOfflinePaymentsConfirmedCents
        )
    }
    for (const row of orderFacet.servedStaff || []) {
        const current = ensure(row._id, row.name)
        current.ordersServed += integer(row.ordersServed)
    }

    return Array.from(staff.values())
        .map((row) => ({
            staffId: row.staffId,
            name: row.name,
            callsAcknowledged: row.callsAcknowledged,
            callsResolved: row.callsResolved,
            averageResponseTimeSeconds:
                row.responseCount > 0
                    ? Math.round(
                          row.totalResponseMilliseconds /
                              row.responseCount /
                              1000
                      )
                    : 0,
            averageResolutionTimeSeconds:
                row.resolutionCount > 0
                    ? Math.round(
                          row.totalResolutionMilliseconds /
                              row.resolutionCount /
                              1000
                      )
                    : 0,
            ordersServed: row.ordersServed,
            paymentsConfirmed: row.paymentsConfirmed,
            totalOfflinePaymentsConfirmedCents:
                row.totalOfflinePaymentsConfirmedCents,
        }))
        .sort(
            (first, second) =>
                second.callsResolved - first.callsResolved ||
                second.paymentsConfirmed -
                    first.paymentsConfirmed
        )
}

export async function getFoodServiceAnalytics({
    businessId,
    analyticsRange,
    financials,
    orderModel = Order,
    serviceRequestModel = ServiceRequest,
    servicePointModel = ServicePoint,
}) {
    if (!financials) {
        throw new TypeError(
            "food-service financial facts are required"
        )
    }

    const [orderAggregation, serviceRequestAggregation] =
        await Promise.all([
            orderModel.aggregate(
                buildFoodServiceOrderPipeline({
                    businessId,
                    analyticsRange,
                })
            ),
            serviceRequestModel.aggregate(
                buildServiceRequestPipeline({
                    businessId,
                    analyticsRange,
                })
            ),
        ])

    const orderFacet = orderAggregation?.[0] || {}
    const serviceRequestFacet =
        serviceRequestAggregation?.[0] || {}
    const overviewRow = orderFacet.overview?.[0] || {}
    const prepTimeCount = integer(overviewRow.prepTimeCount)
    const peakHourIndex = orderFacet.peakOrderHour?.[0]?._id
    const servicePointPerformance =
        await shapeServicePointPerformance({
            rows: orderFacet.servicePointPerformance,
            businessId,
            servicePointModel,
        })
    const serviceRequests =
        shapeServiceRequests(serviceRequestFacet)
    const staffPerformance = shapeStaffPerformance({
        serviceRequestFacet,
        orderFacet,
    })
    const categoryPerformance = shapeCategoryPerformance(
        orderFacet.categoryPerformance
    )

    return {
        overview: {
            paidRevenueCents: financials.current.grossCents,
            activeOrders: integer(overviewRow.activeOrders),
            completedOrders: integer(
                overviewRow.completedOrders
            ),
            averageOrderValueCents:
                financials.current
                    .averageTransactionValueCents,
            comparisonAverageOrderValueCents:
                financials.comparison
                    .averageTransactionValueCents,
            averageOrderValueComparisonPercent:
                financials.averageOrderValueComparisonPercent,
            averagePrepTimeMinutes:
                prepTimeCount > 0
                    ? Math.round(
                          Number(
                              overviewRow.totalPrepMinutes || 0
                          ) / prepTimeCount
                      )
                    : 0,
            peakOrderHour:
                Number.isInteger(Number(peakHourIndex))
                    ? hourLabel(Number(peakHourIndex))
                    : null,
            totalItemsSold: integer(
                orderFacet.totalItemsSold?.[0]?.quantity
            ),
        },
        tips: {
            totalTipsCents:
                financials.current.totalTipsCents,
            averageTipCents:
                financials.current.averageTipCents,
            highestTipCents:
                financials.current.highestTipCents,
            ordersWithTips:
                financials.current.ordersWithTips,
            tipRatePercent:
                financials.current.tipRatePercent,
        },
        revenueByDay: financials.revenueByDay.map((row) => ({
            date: row.date,
            grossCents: row.grossCents,
            orderCount: row.transactionCount,
        })),
        hourlyOrders: shapeHourlyOrders(
            orderFacet.hourlyOrders
        ),
        topItems: (orderFacet.topItems || []).map((row) => ({
            itemName: row._id || "Unknown item",
            quantity: integer(row.quantity),
            paidItemRevenueCents: integer(
                row.paidItemRevenueCents
            ),
            category: row.category || "uncategorized",
        })),
        categoryPerformance,
        categoryRevenueBasis: "paidItemRevenue",
        orderTypeBreakdown: shapeBreakdown({
            ids: ["dine-in", "takeout"],
            countRows: orderFacet.orderTypeCounts,
            revenueRows: orderFacet.orderTypeRevenue,
            idField: "type",
        }),
        channelBreakdown: shapeBreakdown({
            ids: ["self", "waitstaff"],
            labels: {
                self: "Self Ordering",
                waitstaff: "Staff-Assisted Ordering",
            },
            countRows: orderFacet.channelCounts,
            revenueRows: orderFacet.channelRevenue,
            idField: "channel",
        }),
        serviceRequests,
        servicePointPerformance,
        staffPerformance,
    }
}
