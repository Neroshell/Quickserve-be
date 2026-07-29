import Order from "../../models/order.js"
import Reservation from "../../models/Reservation.js"
import { enumerateAnalyticsLocalDates } from "./analyticsRangeService.js"

const NUMERIC_MONGO_TYPES = [
    "int",
    "long",
    "double",
    "decimal",
]

const PAYABLE_ANALYTICS_MODULES = new Set([
    "foodService",
    "lodging",
])

function isNumericField(fieldPath) {
    return {
        $in: [{ $type: fieldPath }, NUMERIC_MONGO_TYPES],
    }
}

function orderGrossCentsExpression() {
    return {
        $cond: [
            {
                $and: [
                    isNumericField("$grossAmount"),
                    { $gte: ["$grossAmount", 0] },
                ],
            },
            { $round: ["$grossAmount", 0] },
            {
                $round: [
                    {
                        $multiply: [
                            { $ifNull: ["$total", 0] },
                            100,
                        ],
                    },
                    0,
                ],
            },
        ],
    }
}

function reservationGrossCentsExpression() {
    return {
        $cond: [
            {
                $and: [
                    isNumericField("$amountPaidCents"),
                    { $gt: ["$amountPaidCents", 0] },
                ],
            },
            { $round: ["$amountPaidCents", 0] },
            {
                $cond: [
                    {
                        $and: [
                            isNumericField("$grossAmount"),
                            { $gt: ["$grossAmount", 0] },
                        ],
                    },
                    { $round: ["$grossAmount", 0] },
                    null,
                ],
            },
        ],
    }
}

function netCentsExpression() {
    return {
        $cond: [
            {
                $and: [
                    isNumericField("$netToBusinessAmount"),
                    { $gte: ["$netToBusinessAmount", 0] },
                ],
            },
            { $round: ["$netToBusinessAmount", 0] },
            null,
        ],
    }
}

function tipCentsExpression() {
    return {
        $round: [
            {
                $multiply: [
                    { $ifNull: ["$tipAmount", 0] },
                    100,
                ],
            },
            0,
        ],
    }
}

export function buildOrderAnalyticsFinancialFields() {
    return {
        analyticsPaidAt: {
            $ifNull: ["$paidAt", "$createdAt"],
        },
        analyticsGrossCents: orderGrossCentsExpression(),
        analyticsNetCents: netCentsExpression(),
        analyticsTipCents: tipCentsExpression(),
    }
}

export function buildReservationAnalyticsFinancialFields() {
    return {
        // Reservation payment lifecycle always stamps paidAt in the verified
        // webhook. Unlike food orders, lodging revenue has no createdAt
        // fallback because that would silently mix acquisition and payment.
        analyticsPaidAt: "$paidAt",
        analyticsGrossCents:
            reservationGrossCentsExpression(),
        analyticsNetCents: netCentsExpression(),
    }
}

export function getLodgingStayMatch() {
    return {
        checkInDate: {
            $type: "string",
            $regex: /^\d{4}-\d{2}-\d{2}$/,
        },
        checkOutDate: {
            $type: "string",
            $regex: /^\d{4}-\d{2}-\d{2}$/,
        },
    }
}

function summaryFacet(startUtc, endUtcExclusive, {
    includeTips = false,
} = {}) {
    return [
        {
            $match: {
                analyticsPaidAt: {
                    $gte: startUtc,
                    $lt: endUtcExclusive,
                },
            },
        },
        {
            $group: {
                _id: null,
                grossCents: { $sum: "$analyticsGrossCents" },
                netCents: {
                    $sum: {
                        $ifNull: ["$analyticsNetCents", 0],
                    },
                },
                netKnownCount: {
                    $sum: {
                        $cond: [
                            { $ne: ["$analyticsNetCents", null] },
                            1,
                            0,
                        ],
                    },
                },
                transactionCount: { $sum: 1 },
                ...(includeTips
                    ? {
                          totalTipsCents: {
                              $sum: "$analyticsTipCents",
                          },
                          highestTipCents: {
                              $max: "$analyticsTipCents",
                          },
                          ordersWithTips: {
                              $sum: {
                                  $cond: [
                                      {
                                          $gt: [
                                              "$analyticsTipCents",
                                              0,
                                          ],
                                      },
                                      1,
                                      0,
                                  ],
                              },
                          },
                      }
                    : {}),
            },
        },
    ]
}

function buildFoodFinancialPipeline({
    businessId,
    analyticsRange,
}) {
    const currentInterval = {
        $gte: analyticsRange.startUtc,
        $lt: analyticsRange.endUtcExclusive,
    }
    const comparisonInterval = {
        $gte: analyticsRange.comparison.startUtc,
        $lt: analyticsRange.comparison.endUtcExclusive,
    }

    return [
        {
            $match: {
                businessId,
                paymentStatus: "paid",
                $or: [
                    { paidAt: currentInterval },
                    { paidAt: comparisonInterval },
                    {
                        paidAt: null,
                        createdAt: currentInterval,
                    },
                    {
                        paidAt: null,
                        createdAt: comparisonInterval,
                    },
                ],
            },
        },
        {
            $addFields: {
                ...buildOrderAnalyticsFinancialFields(),
            },
        },
        {
            $facet: {
                currentSummary: summaryFacet(
                    analyticsRange.startUtc,
                    analyticsRange.endUtcExclusive,
                    { includeTips: true }
                ),
                comparisonSummary: summaryFacet(
                    analyticsRange.comparison.startUtc,
                    analyticsRange.comparison.endUtcExclusive,
                    { includeTips: true }
                ),
                revenueByDay: [
                    {
                        $match: {
                            analyticsPaidAt: currentInterval,
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    date: "$analyticsPaidAt",
                                    format: "%Y-%m-%d",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            grossCents: {
                                $sum: "$analyticsGrossCents",
                            },
                            transactionCount: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
                hourlyRevenue: [
                    {
                        $match: {
                            analyticsPaidAt: currentInterval,
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $hour: {
                                    date: "$analyticsPaidAt",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            paidRevenueCents: {
                                $sum: "$analyticsGrossCents",
                            },
                            paidOrderCount: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]
}

function buildLodgingFinancialPipeline({
    businessId,
    analyticsRange,
}) {
    const currentInterval = {
        $gte: analyticsRange.startUtc,
        $lt: analyticsRange.endUtcExclusive,
    }
    const comparisonInterval = {
        $gte: analyticsRange.comparison.startUtc,
        $lt: analyticsRange.comparison.endUtcExclusive,
    }

    return [
        {
            $match: {
                businessId,
                paymentStatus: "paid",
                ...getLodgingStayMatch(),
                $or: [
                    { paidAt: currentInterval },
                    { paidAt: comparisonInterval },
                ],
            },
        },
        {
            $addFields: {
                ...buildReservationAnalyticsFinancialFields(),
            },
        },
        {
            $match: {
                analyticsGrossCents: { $ne: null },
            },
        },
        {
            $facet: {
                currentSummary: summaryFacet(
                    analyticsRange.startUtc,
                    analyticsRange.endUtcExclusive
                ),
                comparisonSummary: summaryFacet(
                    analyticsRange.comparison.startUtc,
                    analyticsRange.comparison.endUtcExclusive
                ),
                revenueByDay: [
                    {
                        $match: {
                            analyticsPaidAt: currentInterval,
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    date: "$analyticsPaidAt",
                                    format: "%Y-%m-%d",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            grossCents: {
                                $sum: "$analyticsGrossCents",
                            },
                            transactionCount: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]
}

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.round(number) : 0
}

function shapeSummary(rows) {
    const row = rows?.[0] || {}
    const transactionCount = integer(row.transactionCount)
    const grossCents = integer(row.grossCents)
    const netKnownCount = integer(row.netKnownCount)
    const ordersWithTips = integer(row.ordersWithTips)
    const totalTipsCents = integer(row.totalTipsCents)

    return {
        grossCents,
        netToBusinessCents:
            transactionCount === 0
                ? 0
                : netKnownCount === transactionCount
                  ? integer(row.netCents)
                  : null,
        transactionCount,
        averageTransactionValueCents:
            transactionCount > 0
                ? Math.round(grossCents / transactionCount)
                : 0,
        totalTipsCents,
        averageTipCents:
            ordersWithTips > 0
                ? Math.round(totalTipsCents / ordersWithTips)
                : 0,
        highestTipCents: integer(row.highestTipCents),
        ordersWithTips,
        tipRatePercent:
            transactionCount > 0
                ? Math.round(
                      (ordersWithTips / transactionCount) * 1000
                  ) / 10
                : 0,
    }
}

export function calculateComparisonPercent(current, previous) {
    const currentValue = Number(current || 0)
    const previousValue = Number(previous || 0)

    if (previousValue === 0) {
        return currentValue === 0 ? 0 : null
    }

    return (
        Math.round(
            ((currentValue - previousValue) / previousValue) *
                10000
        ) / 100
    )
}

function shapeRevenueByDay(rows, analyticsRange) {
    const byDate = new Map(
        (rows || []).map((row) => [
            row._id,
            {
                grossCents: integer(row.grossCents),
                transactionCount: integer(row.transactionCount),
            },
        ])
    )

    return enumerateAnalyticsLocalDates(analyticsRange).map(
        (date) => ({
            date,
            grossCents: byDate.get(date)?.grossCents || 0,
            transactionCount:
                byDate.get(date)?.transactionCount || 0,
        })
    )
}

function hourLabel(hourIndex) {
    const hour =
        hourIndex > 12
            ? hourIndex - 12
            : hourIndex === 0
              ? 12
              : hourIndex
    return `${hour}${hourIndex >= 12 ? "PM" : "AM"}`
}

function shapeHourlyRevenue(rows) {
    const byHour = new Map(
        (rows || []).map((row) => [
            Number(row._id),
            {
                paidRevenueCents: integer(
                    row.paidRevenueCents
                ),
                paidOrderCount: integer(row.paidOrderCount),
            },
        ])
    )

    return Array.from({ length: 24 }, (_, hourIndex) => ({
        hour: hourLabel(hourIndex),
        paidRevenueCents:
            byHour.get(hourIndex)?.paidRevenueCents || 0,
        paidOrderCount:
            byHour.get(hourIndex)?.paidOrderCount || 0,
    }))
}

function combineSummaries(summaries) {
    const transactionCount = summaries.reduce(
        (sum, summary) => sum + summary.transactionCount,
        0
    )
    const grossCents = summaries.reduce(
        (sum, summary) => sum + summary.grossCents,
        0
    )
    const netIsComplete = summaries.every(
        (summary) =>
            summary.transactionCount === 0 ||
            summary.netToBusinessCents !== null
    )

    return {
        grossCents,
        netToBusinessCents:
            transactionCount === 0
                ? 0
                : netIsComplete
                  ? summaries.reduce(
                        (sum, summary) =>
                            sum +
                            Number(
                                summary.netToBusinessCents || 0
                            ),
                        0
                    )
                  : null,
        transactionCount,
        averageTransactionValueCents:
            transactionCount > 0
                ? Math.round(grossCents / transactionCount)
                : 0,
    }
}

function combineRevenueByDay(moduleRows) {
    const combined = new Map()

    for (const rows of moduleRows) {
        for (const row of rows) {
            const current = combined.get(row.date) || {
                grossCents: 0,
                transactionCount: 0,
            }
            current.grossCents += row.grossCents
            current.transactionCount += row.transactionCount
            combined.set(row.date, current)
        }
    }

    return Array.from(combined.entries())
        .sort(([first], [second]) =>
            first.localeCompare(second)
        )
        .map(([date, row]) => ({
            date,
            grossCents: row.grossCents,
            transactionCount: row.transactionCount,
        }))
}

function shapeModuleFinancials(facet, analyticsRange, {
    hourly = false,
} = {}) {
    const current = shapeSummary(facet.currentSummary)
    const comparison = shapeSummary(
        facet.comparisonSummary
    )
    const revenueByDay = shapeRevenueByDay(
        facet.revenueByDay,
        analyticsRange
    )

    return {
        current,
        comparison,
        revenueByDay,
        ...(hourly
            ? {
                  hourlyOrders: shapeHourlyRevenue(
                      facet.hourlyRevenue
                  ),
              }
            : {}),
        averageTransactionValueComparisonPercent:
            calculateComparisonPercent(
                current.averageTransactionValueCents,
                comparison.averageTransactionValueCents
            ),
    }
}

/**
 * Build the authoritative paid financial union for enabled payable modules.
 *
 * Orders and Reservations remain separate persistence domains and are
 * aggregated independently. Their shaped module contributions are combined
 * exactly once, so hybrid shared totals cannot double count either entity.
 */
export async function getSharedAnalytics({
    businessId,
    enabledAnalyticsModules = ["foodService"],
    analyticsRange,
    foodOperationalRange = analyticsRange,
    lodgingCalendarRange = analyticsRange,
    orderModel = Order,
    reservationModel = Reservation,
}) {
    const enabledPayableModules =
        enabledAnalyticsModules.filter((moduleId) =>
            PAYABLE_ANALYTICS_MODULES.has(moduleId)
        )
    const foodEnabled =
        enabledPayableModules.includes("foodService")
    const lodgingEnabled =
        enabledPayableModules.includes("lodging")

    const [foodAggregation, lodgingAggregation] =
        await Promise.all([
            foodEnabled
                ? orderModel.aggregate(
                      buildFoodFinancialPipeline({
                          businessId,
                          analyticsRange:
                              foodOperationalRange,
                      })
                  )
                : Promise.resolve([]),
            lodgingEnabled
                ? reservationModel.aggregate(
                      buildLodgingFinancialPipeline({
                          businessId,
                          analyticsRange:
                              lodgingCalendarRange,
                      })
                  )
                : Promise.resolve([]),
        ])

    const moduleFinancials = new Map()
    if (foodEnabled) {
        moduleFinancials.set(
            "foodService",
            shapeModuleFinancials(
                foodAggregation?.[0] || {},
                foodOperationalRange,
                { hourly: true }
            )
        )
    }
    if (lodgingEnabled) {
        moduleFinancials.set(
            "lodging",
            shapeModuleFinancials(
                lodgingAggregation?.[0] || {},
                lodgingCalendarRange
            )
        )
    }

    const current = combineSummaries(
        enabledPayableModules.map(
            (moduleId) =>
                moduleFinancials.get(moduleId).current
        )
    )
    const comparison = combineSummaries(
        enabledPayableModules.map(
            (moduleId) =>
                moduleFinancials.get(moduleId).comparison
        )
    )
    const revenueByDay = combineRevenueByDay(
        enabledPayableModules.map(
            (moduleId) =>
                moduleFinancials.get(moduleId).revenueByDay
        )
    )

    const result = {
        shared: {
            paidRevenue: {
                ...current,
                comparisonPercent:
                    calculateComparisonPercent(
                        current.grossCents,
                        comparison.grossCents
                    ),
            },
            revenueByDay,
            revenueByModule: enabledPayableModules.map(
                (moduleId) => {
                    const financials =
                        moduleFinancials.get(moduleId).current
                    return {
                        module: moduleId,
                        grossCents: financials.grossCents,
                        transactionCount:
                            financials.transactionCount,
                    }
                }
            ),
        },
    }

    if (foodEnabled) {
        const food = moduleFinancials.get("foodService")
        result.foodServiceFinancials = {
            ...food,
            averageOrderValueComparisonPercent:
                food.averageTransactionValueComparisonPercent,
        }
    }
    if (lodgingEnabled) {
        result.lodgingFinancials =
            moduleFinancials.get("lodging")
    }

    return result
}
