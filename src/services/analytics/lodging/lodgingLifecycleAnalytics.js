import Reservation from "../../../models/Reservation.js"
import { enumerateAnalyticsLocalDates } from "../analyticsRangeService.js"
import {
    calculateComparisonPercent,
    getLodgingStayMatch,
} from "../sharedAnalyticsService.js"
import {
    LODGING_BOOKING_DECISION_STATUSES,
    LODGING_SCHEDULED_STAY_STATUSES,
} from "./lodgingAnalyticsConstants.js"

function interval(startUtc, endUtcExclusive) {
    return {
        $gte: startUtc,
        $lt: endUtcExclusive,
    }
}

function currentInterval(analyticsRange) {
    return interval(
        analyticsRange.startUtc,
        analyticsRange.endUtcExclusive
    )
}

function comparisonInterval(analyticsRange) {
    return interval(
        analyticsRange.comparison.startUtc,
        analyticsRange.comparison.endUtcExclusive
    )
}

function eventDateGroup(field, timezone) {
    return {
        _id: {
            $dateToString: {
                date: field,
                format: "%Y-%m-%d",
                timezone,
            },
        },
        count: { $sum: 1 },
    }
}

function buildConfirmationPipeline({
    businessId,
    analyticsRange,
}) {
    const current = currentInterval(analyticsRange)
    const comparison = comparisonInterval(analyticsRange)
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                $or: [
                    { confirmedAt: current },
                    { confirmedAt: comparison },
                ],
            },
        },
        {
            $facet: {
                current: [
                    { $match: { confirmedAt: current } },
                    { $count: "count" },
                ],
                comparison: [
                    { $match: { confirmedAt: comparison } },
                    { $count: "count" },
                ],
                trend: [
                    { $match: { confirmedAt: current } },
                    {
                        $group: eventDateGroup(
                            "$confirmedAt",
                            analyticsRange.timezone
                        ),
                    },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]
}

function buildCancellationPipeline({
    businessId,
    analyticsRange,
}) {
    const current = currentInterval(analyticsRange)
    const comparison = comparisonInterval(analyticsRange)
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                $or: [
                    { cancelledAt: current },
                    { cancelledAt: comparison },
                ],
            },
        },
        {
            $facet: {
                current: [
                    { $match: { cancelledAt: current } },
                    { $count: "count" },
                ],
                comparison: [
                    { $match: { cancelledAt: comparison } },
                    { $count: "count" },
                ],
                trend: [
                    { $match: { cancelledAt: current } },
                    {
                        $group: eventDateGroup(
                            "$cancelledAt",
                            analyticsRange.timezone
                        ),
                    },
                    { $sort: { _id: 1 } },
                ],
                reasons: [
                    {
                        $match: {
                            cancelledAt: current,
                            cancellationReason: {
                                $type: "string",
                                $ne: "",
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$cancellationReason",
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1, _id: 1 } },
                ],
            },
        },
    ]
}

function scheduledInstantExpression({
    dateField,
    time,
    timezone,
}) {
    return {
        $dateFromString: {
            dateString: {
                $concat: [dateField, "T", time, ":00"],
            },
            timezone,
            onError: null,
            onNull: null,
        },
    }
}

function staffFacet({
    eventField,
    actorPath,
    dateField,
    scheduledTime,
    timezone,
}) {
    const scheduledAt = scheduledInstantExpression({
        dateField,
        time: scheduledTime,
        timezone,
    })
    return [
        {
            $addFields: {
                analyticsScheduledAt: scheduledAt,
            },
        },
        {
            $group: {
                _id: {
                    staffId: {
                        $ifNull: [
                            `${actorPath}.userId`,
                            null,
                        ],
                    },
                    name: {
                        $ifNull: [
                            `${actorPath}.name`,
                            null,
                        ],
                    },
                },
                count: { $sum: 1 },
                totalDelayMinutes: {
                    $sum: {
                        $cond: [
                            {
                                $ne: [
                                    "$analyticsScheduledAt",
                                    null,
                                ],
                            },
                            {
                                $divide: [
                                    {
                                        $subtract: [
                                            eventField,
                                            "$analyticsScheduledAt",
                                        ],
                                    },
                                    60000,
                                ],
                            },
                            0,
                        ],
                    },
                },
                delayCount: {
                    $sum: {
                        $cond: [
                            {
                                $ne: [
                                    "$analyticsScheduledAt",
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
        { $sort: { count: -1, "_id.name": 1 } },
    ]
}

function buildCheckInPipeline({
    businessId,
    analyticsRange,
    checkInTime,
}) {
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                checkedInAt: currentInterval(analyticsRange),
            },
        },
        {
            $facet: {
                staff: staffFacet({
                    eventField: "$checkedInAt",
                    actorPath: "$checkedInBy",
                    dateField: "$checkInDate",
                    scheduledTime: checkInTime,
                    timezone: analyticsRange.timezone,
                }),
            },
        },
    ]
}

function buildCheckoutPipeline({
    businessId,
    analyticsRange,
    checkOutTime,
}) {
    const current = currentInterval(analyticsRange)
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                checkedOutAt: current,
            },
        },
        {
            $facet: {
                total: [{ $count: "count" }],
                trend: [
                    {
                        $group: eventDateGroup(
                            "$checkedOutAt",
                            analyticsRange.timezone
                        ),
                    },
                    { $sort: { _id: 1 } },
                ],
                staff: staffFacet({
                    eventField: "$checkedOutAt",
                    actorPath: "$checkedOutBy",
                    dateField: "$checkOutDate",
                    scheduledTime: checkOutTime,
                    timezone: analyticsRange.timezone,
                }),
            },
        },
    ]
}

function buildCancellationCohortPipeline({
    businessId,
    analyticsRange,
}) {
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                createdAt: currentInterval(analyticsRange),
                status: {
                    $in: LODGING_BOOKING_DECISION_STATUSES,
                },
            },
        },
        {
            $group: {
                _id: null,
                eligibleCount: { $sum: 1 },
                cancelledCount: {
                    $sum: {
                        $cond: [
                            { $eq: ["$status", "cancelled"] },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ]
}

function buildScheduledDeparturePipeline({
    businessId,
    analyticsRange,
}) {
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                checkOutDate: {
                    $gte: analyticsRange.from,
                    $lte: analyticsRange.to,
                },
                status: {
                    $in: LODGING_SCHEDULED_STAY_STATUSES,
                },
            },
        },
        {
            $group: {
                _id: null,
                scheduledCount: { $sum: 1 },
                completedScheduledCount: {
                    $sum: {
                        $cond: [
                            {
                                $eq: [
                                    { $type: "$checkedOutAt" },
                                    "date",
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ]
}

function integer(value) {
    const parsed = Number(value || 0)
    return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function percentOrNull(numerator, denominator) {
    if (denominator <= 0) return null
    return (
        Math.round((numerator / denominator) * 1000) /
        10
    )
}

function trend(rows, analyticsRange) {
    if (!rows?.length) return []
    const values = new Map(
        rows.map((row) => [
            row._id,
            integer(row.count),
        ])
    )
    return enumerateAnalyticsLocalDates(analyticsRange).map(
        (date) => ({
            date,
            count: values.get(date) || 0,
        })
    )
}

function reasonBreakdown(rows) {
    const total = (rows || []).reduce(
        (sum, row) => sum + integer(row.count),
        0
    )
    return (rows || []).map((row) => {
        const count = integer(row.count)
        return {
            reason: row._id,
            count,
            percentagePercent:
                percentOrNull(count, total) || 0,
        }
    })
}

function shapeStaff(
    rows,
    total,
    countField,
    averageDelayField
) {
    const unattributed = (rows || [])
        .filter((row) => !row._id?.staffId)
        .reduce(
            (sum, row) => sum + integer(row.count),
            0
        )
    const attributed = (rows || [])
        .filter((row) => row._id?.staffId)
        .map((row) => {
            const count = integer(row.count)
            const delayCount = integer(row.delayCount)
            return {
                staffId: row._id.staffId,
                name:
                    row._id.name || "Unknown Staff",
                [countField]: count,
                percentagePercent:
                    percentOrNull(count, total) || 0,
                [averageDelayField]:
                    delayCount > 0
                        ? Math.round(
                              (Number(
                                  row.totalDelayMinutes || 0
                              ) /
                                  delayCount) *
                                  10
                          ) / 10
                        : null,
            }
        })

    return { attributed, unattributed }
}

export async function getLodgingLifecycleAnalytics({
    businessId,
    analyticsRange,
    hotelSettings = {},
    reservationModel = Reservation,
}) {
    const checkInTime =
        hotelSettings.checkInTime || "15:00"
    const checkOutTime =
        hotelSettings.checkOutTime || "11:00"

    const [
        confirmationRows,
        cancellationRows,
        checkoutRows,
        checkInRows,
        cancellationCohortRows,
        scheduledDepartureRows,
    ] = await Promise.all([
        reservationModel.aggregate(
            buildConfirmationPipeline({
                businessId,
                analyticsRange,
            })
        ),
        reservationModel.aggregate(
            buildCancellationPipeline({
                businessId,
                analyticsRange,
            })
        ),
        reservationModel.aggregate(
            buildCheckoutPipeline({
                businessId,
                analyticsRange,
                checkOutTime,
            })
        ),
        reservationModel.aggregate(
            buildCheckInPipeline({
                businessId,
                analyticsRange,
                checkInTime,
            })
        ),
        reservationModel.aggregate(
            buildCancellationCohortPipeline({
                businessId,
                analyticsRange,
            })
        ),
        reservationModel.aggregate(
            buildScheduledDeparturePipeline({
                businessId,
                analyticsRange,
            })
        ),
    ])

    const confirmations = confirmationRows?.[0] || {}
    const cancellations = cancellationRows?.[0] || {}
    const checkouts = checkoutRows?.[0] || {}
    const checkIns = checkInRows?.[0] || {}
    const cohort = cancellationCohortRows?.[0] || {}
    const scheduled =
        scheduledDepartureRows?.[0] || {}

    const confirmationCount = integer(
        confirmations.current?.[0]?.count
    )
    const priorConfirmationCount = integer(
        confirmations.comparison?.[0]?.count
    )
    const cancellationCount = integer(
        cancellations.current?.[0]?.count
    )
    const priorCancellationCount = integer(
        cancellations.comparison?.[0]?.count
    )
    const actualCheckoutCount = integer(
        checkouts.total?.[0]?.count
    )
    const scheduledCount = integer(
        scheduled.scheduledCount
    )
    const completedScheduledCount = integer(
        scheduled.completedScheduledCount
    )
    const actualCheckInCount = (checkIns.staff || [])
        .reduce(
            (sum, row) => sum + integer(row.count),
            0
        )
    const checkInStaff = shapeStaff(
        checkIns.staff,
        actualCheckInCount,
        "checkInsCompleted",
        "averageCheckInDelayMinutes"
    )
    const checkOutStaff = shapeStaff(
        checkouts.staff,
        actualCheckoutCount,
        "checkOutsCompleted",
        "averageCheckoutDelayMinutes"
    )

    return {
        lifecycle: {
            confirmations: {
                count: confirmationCount,
                comparisonPercent:
                    calculateComparisonPercent(
                        confirmationCount,
                        priorConfirmationCount
                    ),
            },
            cancellations: {
                count: cancellationCount,
                cancelledBookingCohortRatePercent:
                    percentOrNull(
                        integer(cohort.cancelledCount),
                        integer(cohort.eligibleCount)
                    ),
                comparisonPercent:
                    calculateComparisonPercent(
                        cancellationCount,
                        priorCancellationCount
                    ),
            },
            checkouts: {
                actualCount: actualCheckoutCount,
                scheduledCount,
                completedScheduledCount,
                completionRatePercent:
                    percentOrNull(
                        completedScheduledCount,
                        scheduledCount
                    ),
            },
        },
        confirmationTrend: trend(
            confirmations.trend,
            analyticsRange
        ),
        cancellationTrend: trend(
            cancellations.trend,
            analyticsRange
        ),
        cancellationReasonBreakdown:
            reasonBreakdown(cancellations.reasons),
        checkoutTrend: trend(
            checkouts.trend,
            analyticsRange
        ),
        checkInStaffPerformance:
            checkInStaff.attributed,
        checkOutStaffPerformance:
            checkOutStaff.attributed,
        staffAttribution: {
            unattributedCheckIns:
                checkInStaff.unattributed,
            unattributedCheckOuts:
                checkOutStaff.unattributed,
        },
    }
}
