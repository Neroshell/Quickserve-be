import { DateTime } from "luxon"
import Reservation from "../../models/Reservation.js"
import ServicePoint from "../../models/ServicePoint.js"
import {
    enumerateAnalyticsLocalDates,
} from "./analyticsRangeService.js"
import {
    buildReservationAnalyticsFinancialFields,
    calculateComparisonPercent,
    getLodgingStayMatch,
} from "./sharedAnalyticsService.js"
import {
    LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
    LODGING_EXPIRED_PENDING_PAYMENT_STATUSES,
    LODGING_INVENTORY_BLOCKING_STATUSES,
    LODGING_SCHEDULED_STAY_STATUSES,
    LODGING_STAY_LENGTH_STATUSES,
} from "./lodging/lodgingAnalyticsConstants.js"
import { getLodgingLifecycleAnalytics } from "./lodging/lodgingLifecycleAnalytics.js"
import { getLodgingRoomTypeAnalytics } from "./lodging/lodgingRoomTypeAnalytics.js"

export {
    LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
    LODGING_BOOKING_DECISION_STATUSES,
    LODGING_EXPIRED_PENDING_PAYMENT_STATUSES,
    LODGING_INVENTORY_BLOCKING_STATUSES,
    LODGING_NON_SERVICE_TERMINAL_STATUSES,
    LODGING_ROOM_TYPE_STAY_STATUSES,
    LODGING_SCHEDULED_STAY_STATUSES,
    LODGING_STAY_LENGTH_STATUSES,
} from "./lodging/lodgingAnalyticsConstants.js"

function currentInterval(analyticsRange) {
    return {
        $gte: analyticsRange.startUtc,
        $lt: analyticsRange.endUtcExclusive,
    }
}

function percentagePercent(value, total) {
    if (total <= 0) return 0
    return Math.round((value / total) * 1000) / 10
}

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.round(number) : 0
}

function buildLodgingPipeline({
    businessId,
    analyticsRange,
    snapshotDate,
}) {
    const createdAt = currentInterval(analyticsRange)
    const selectedCheckInDates = {
        $gte: analyticsRange.from,
        $lte: analyticsRange.to,
    }
    const selectedCheckOutDates = {
        $gte: analyticsRange.from,
        $lte: analyticsRange.to,
    }
    const intervalEndDate = DateTime.fromISO(
        analyticsRange.to,
        { zone: analyticsRange.timezone }
    )
        .plus({ days: 1 })
        .toISODate()
    const snapshotEndDate = DateTime.fromISO(snapshotDate, {
        zone: analyticsRange.timezone,
    })
        .plus({ days: 1 })
        .toISODate()

    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
            },
        },
        {
            $addFields: {
                ...buildReservationAnalyticsFinancialFields(),
            },
        },
        {
            $facet: {
                bookingTrend: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    date: "$createdAt",
                                    format: "%Y-%m-%d",
                                    timezone:
                                        analyticsRange.timezone,
                                },
                            },
                            bookingCount: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
                reservationStatusBreakdown: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: "$status",
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1, _id: 1 } },
                ],
                paymentStatusBreakdown: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: "$paymentStatus",
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1, _id: 1 } },
                ],
                bookingSourceBreakdown: [
                    { $match: { createdAt } },
                    {
                        $group: {
                            _id: "$source",
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1, _id: 1 } },
                ],
                stayLength: [
                    {
                        $match: {
                            createdAt,
                            status: {
                                $in: LODGING_STAY_LENGTH_STATUSES,
                            },
                            numberOfNights: { $gte: 1 },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalNights: {
                                $sum: "$numberOfNights",
                            },
                            stayCount: { $sum: 1 },
                        },
                    },
                ],
                arrivals: [
                    {
                        $match: {
                            checkInDate:
                                selectedCheckInDates,
                            status: {
                                $in: LODGING_SCHEDULED_STAY_STATUSES,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            scheduled: { $sum: 1 },
                            checkedIn: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                {
                                                    $type:
                                                        "$checkedInAt",
                                                },
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
                ],
                departures: [
                    {
                        $match: {
                            checkOutDate:
                                selectedCheckOutDates,
                            status: {
                                $in: LODGING_SCHEDULED_STAY_STATUSES,
                            },
                        },
                    },
                    { $count: "scheduled" },
                ],
                actualCheckIns: [
                    {
                        $match: {
                            checkedInAt: currentInterval(
                                analyticsRange
                            ),
                        },
                    },
                    { $count: "count" },
                ],
                roomRevenuePerformance: [
                    {
                        $match: {
                            paymentStatus: "paid",
                            paidAt: currentInterval(
                                analyticsRange
                            ),
                            analyticsGrossCents: {
                                $ne: null,
                            },
                            servicePointId: { $ne: null },
                        },
                    },
                    {
                        $group: {
                            _id: "$servicePointId",
                            displayLabel: {
                                $first:
                                    "$servicePointLabel",
                            },
                            paidBookingCount: { $sum: 1 },
                            paidRevenueCents: {
                                $sum:
                                    "$analyticsGrossCents",
                            },
                            totalNights: {
                                $sum: {
                                    $cond: [
                                        {
                                            $gte: [
                                                "$numberOfNights",
                                                1,
                                            ],
                                        },
                                        "$numberOfNights",
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    {
                        $sort: {
                            paidRevenueCents: -1,
                            _id: 1,
                        },
                    },
                ],
                occupancyStays: [
                    {
                        $match: {
                            status: {
                                $in: LODGING_INVENTORY_BLOCKING_STATUSES,
                            },
                            checkInDate: {
                                $lt: intervalEndDate,
                            },
                            checkOutDate: {
                                $gt: analyticsRange.from,
                            },
                            servicePointId: {
                                $ne: null,
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            servicePointId: 1,
                            checkInDate: 1,
                            checkOutDate: 1,
                        },
                    },
                ],
                occupiedToday: [
                    {
                        $match: {
                            status: {
                                $in: LODGING_INVENTORY_BLOCKING_STATUSES,
                            },
                            checkInDate: {
                                $lt: snapshotEndDate,
                            },
                            checkOutDate: {
                                $gt: snapshotDate,
                            },
                            servicePointId: {
                                $ne: null,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$servicePointId",
                        },
                    },
                ],
            },
        },
    ]
}

function buildPendingPaymentPipeline({
    businessId,
    generatedAt,
}) {
    return [
        {
            $match: {
                businessId,
                paymentStatus: "pending",
                ...getLodgingStayMatch(),
                $or: [
                    {
                        status: {
                            $in: LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
                        },
                        paymentExpiresAt: {
                            $gt: generatedAt,
                        },
                    },
                    {
                        status: {
                            $in: LODGING_EXPIRED_PENDING_PAYMENT_STATUSES,
                        },
                        paymentExpiresAt: {
                            $lte: generatedAt,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                ...buildReservationAnalyticsFinancialFields(),
            },
        },
        {
            $facet: {
                active: [
                    {
                        $match: {
                            status: {
                                $in: LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
                            },
                            paymentExpiresAt: {
                                $gt: generatedAt,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            count: { $sum: 1 },
                            valueCents: {
                                $sum: {
                                    $ifNull: [
                                        "$analyticsGrossCents",
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
                expired: [
                    {
                        $match: {
                            status: {
                                $in: LODGING_EXPIRED_PENDING_PAYMENT_STATUSES,
                            },
                            paymentExpiresAt: {
                                $lte: generatedAt,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            count: { $sum: 1 },
                            valueCents: {
                                $sum: {
                                    $ifNull: [
                                        "$analyticsGrossCents",
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

function shapeBreakdown(rows, fieldName) {
    const total = (rows || []).reduce(
        (sum, row) => sum + integer(row.count),
        0
    )

    return (rows || []).map((row) => {
        const count = integer(row.count)
        return {
            [fieldName]: row._id || "unknown",
            count,
            percentagePercent: percentagePercent(
                count,
                total
            ),
        }
    })
}

function shapeBookingTrend(rows, analyticsRange) {
    if (!rows?.length) return []

    const byDate = new Map(
        rows.map((row) => [
            row._id,
            integer(row.bookingCount),
        ])
    )

    return enumerateAnalyticsLocalDates(analyticsRange).map(
        (date) => ({
            date,
            bookingCount: byDate.get(date) || 0,
        })
    )
}

function shapePendingPayments(facet) {
    const active = facet.active?.[0] || {}
    const expired = facet.expired?.[0] || {}

    return {
        activeCount: integer(active.count),
        expiredCount: integer(expired.count),
        activeValueCents: integer(active.valueCents),
        expiredValueCents: integer(expired.valueCents),
        snapshotAt: null,
    }
}

async function loadServicePoints({
    servicePointModel,
    businessId,
    performanceIds,
}) {
    const query = servicePointModel.find(
        {
            businessId,
            $or: [
                {
                    servicePointId: {
                        $in: performanceIds,
                    },
                },
                {
                    servicePointType: "room",
                    isActive: true,
                    reservable: true,
                },
            ],
        },
        "servicePointId label code servicePointType isActive reservable"
    )

    return typeof query?.lean === "function"
        ? query.lean()
        : query
}

function shapeRoomPerformance(rows, metadata) {
    return (rows || []).map((row) => {
        const servicePoint = metadata.get(row._id)
        const paidBookingCount = integer(
            row.paidBookingCount
        )
        const paidRevenueCents = integer(
            row.paidRevenueCents
        )

        return {
            servicePointId: row._id || "",
            label:
                servicePoint?.label ||
                row.displayLabel ||
                row._id ||
                "Unknown",
            code: servicePoint?.code || "",
            paidBookingCount,
            paidRevenueCents,
            averageBookingValueCents:
                paidBookingCount > 0
                    ? Math.round(
                          paidRevenueCents /
                              paidBookingCount
                      )
                    : 0,
            totalNights: integer(row.totalNights),
        }
    })
}

function occupiedRoomNightKeys({
    servicePointId,
    checkInDate,
    checkOutDate,
    rangeFrom,
    rangeToExclusive,
    timezone,
}) {
    const checkIn = DateTime.fromISO(checkInDate, {
        zone: timezone,
    }).startOf("day")
    const checkOut = DateTime.fromISO(checkOutDate, {
        zone: timezone,
    }).startOf("day")
    const from = DateTime.fromISO(rangeFrom, {
        zone: timezone,
    }).startOf("day")
    const to = DateTime.fromISO(rangeToExclusive, {
        zone: timezone,
    }).startOf("day")

    if (
        !checkIn.isValid ||
        !checkOut.isValid ||
        checkOut <= checkIn
    ) {
        return []
    }

    const overlapStart = checkIn > from ? checkIn : from
    const overlapEnd = checkOut < to ? checkOut : to
    if (overlapEnd <= overlapStart) return []

    const keys = []
    let date = overlapStart

    while (date < overlapEnd) {
        keys.push(
            `${servicePointId}:${date.toISODate()}`
        )
        date = date.plus({ days: 1 })
    }

    return keys
}

function shapeOccupancy({
    stays,
    occupiedTodayRows,
    roomInventory,
    analyticsRange,
}) {
    const roomIds = new Set(
        roomInventory.map(
            (servicePoint) =>
                servicePoint.servicePointId
        )
    )
    const intervalEnd = DateTime.fromISO(
        analyticsRange.to,
        { zone: analyticsRange.timezone }
    )
        .plus({ days: 1 })
        .toISODate()
    const selectedDays =
        enumerateAnalyticsLocalDates(analyticsRange).length
    const availableRoomNights =
        roomInventory.length * selectedDays
    const occupiedRoomNightSet = new Set()
    for (const stay of stays || []) {
        if (!roomIds.has(stay.servicePointId)) continue

        for (const key of occupiedRoomNightKeys({
            ...stay,
            rangeFrom: analyticsRange.from,
            rangeToExclusive: intervalEnd,
            timezone: analyticsRange.timezone,
        })) {
            occupiedRoomNightSet.add(key)
        }
    }
    const occupiedRoomNights =
        occupiedRoomNightSet.size
    const occupiedRoomsForToday = new Set(
        (occupiedTodayRows || [])
            .map((row) => row._id)
            .filter((id) => roomIds.has(id))
    ).size

    return {
        occupiedRoomNights,
        availableRoomNights,
        occupancyRatePercent:
            availableRoomNights > 0
                ? percentagePercent(
                      occupiedRoomNights,
                      availableRoomNights
                  )
                : null,
        occupiedRoomsForToday,
        availableRoomsForToday: Math.max(
            0,
            roomInventory.length -
                occupiedRoomsForToday
        ),
    }
}

/**
 * Tenant-scoped lodging analytics. This service contains no HTTP or
 * food-service behavior; financial facts are supplied by the shared union.
 */
export async function getLodgingAnalytics({
    businessId,
    analyticsRange,
    financials,
    generatedAt = new Date(),
    hotelSettings = {},
    reservationModel = Reservation,
    servicePointModel = ServicePoint,
    lifecycleAnalytics =
        getLodgingLifecycleAnalytics,
    roomTypeAnalytics =
        getLodgingRoomTypeAnalytics,
}) {
    if (!financials) {
        throw new TypeError(
            "lodging financial facts are required"
        )
    }

    const generatedAtDate =
        generatedAt instanceof Date
            ? generatedAt
            : new Date(generatedAt)
    const snapshotDate = DateTime.fromJSDate(
        generatedAtDate,
        { zone: analyticsRange.timezone }
    ).toISODate()

    const [
        reservationAggregation,
        pendingAggregation,
        lifecycleResult,
        roomTypePerformance,
    ] =
        await Promise.all([
            reservationModel.aggregate(
                buildLodgingPipeline({
                    businessId,
                    analyticsRange,
                    snapshotDate,
                })
            ),
            reservationModel.aggregate(
                buildPendingPaymentPipeline({
                    businessId,
                    generatedAt: generatedAtDate,
                })
            ),
            lifecycleAnalytics({
                businessId,
                analyticsRange,
                hotelSettings,
                reservationModel,
            }),
            roomTypeAnalytics({
                businessId,
                analyticsRange,
                reservationModel,
                servicePointModel,
            }),
        ])

    const facet = reservationAggregation?.[0] || {}
    const pendingFacet = pendingAggregation?.[0] || {}
    const performanceIds = (
        facet.roomRevenuePerformance || []
    )
        .map((row) => row._id)
        .filter(Boolean)
    const servicePoints = await loadServicePoints({
        servicePointModel,
        businessId,
        performanceIds,
    })
    const metadata = new Map(
        (servicePoints || []).map((servicePoint) => [
            servicePoint.servicePointId,
            servicePoint,
        ])
    )
    const roomInventory = (servicePoints || []).filter(
        (servicePoint) =>
            servicePoint.servicePointType === "room" &&
            servicePoint.isActive === true &&
            servicePoint.reservable === true
    )
    const pendingPayments =
        shapePendingPayments(pendingFacet)
    pendingPayments.snapshotAt =
        generatedAtDate.toISOString()

    const stayLength = facet.stayLength?.[0] || {}
    const stayCount = integer(stayLength.stayCount)
    const arrivalsRow = facet.arrivals?.[0] || {}
    const scheduledArrivals = integer(
        arrivalsRow.scheduled
    )
    const checkedInArrivals = integer(
        arrivalsRow.checkedIn
    )
    const scheduledDepartures = integer(
        facet.departures?.[0]?.scheduled
    )
    const actualCheckIns = integer(
        facet.actualCheckIns?.[0]?.count
    )

    return {
        overview: {
            paidBookingRevenueCents:
                financials.current.grossCents,
            paidBookingRevenueComparisonPercent:
                calculateComparisonPercent(
                    financials.current.grossCents,
                    financials.comparison.grossCents
                ),
            paidBookingCount:
                financials.current.transactionCount,
            averageBookingValueCents:
                financials.current
                    .averageTransactionValueCents,
            averageBookingValueComparisonPercent:
                financials
                    .averageTransactionValueComparisonPercent,
            averageLengthOfStayNights:
                stayCount > 0
                    ? Math.round(
                          (Number(
                              stayLength.totalNights || 0
                          ) /
                              stayCount) *
                              10
                      ) / 10
                    : 0,
            scheduledArrivals,
            scheduledDepartures,
            actualCheckIns,
            pendingPaymentCount:
                pendingPayments.activeCount,
            pendingPaymentValueCents:
                pendingPayments.activeValueCents,
        },
        bookingRevenueByDay:
            financials.current.transactionCount > 0
                ? financials.revenueByDay.map((row) => ({
                      date: row.date,
                      grossCents: row.grossCents,
                      bookingCount:
                          row.transactionCount,
                  }))
                : [],
        bookingTrend: shapeBookingTrend(
            facet.bookingTrend,
            analyticsRange
        ),
        reservationStatusBreakdown: shapeBreakdown(
            facet.reservationStatusBreakdown,
            "status"
        ),
        paymentStatusBreakdown: shapeBreakdown(
            facet.paymentStatusBreakdown,
            "status"
        ),
        bookingSourceBreakdown: shapeBreakdown(
            facet.bookingSourceBreakdown,
            "source"
        ),
        roomRevenuePerformance:
            shapeRoomPerformance(
                facet.roomRevenuePerformance,
                metadata
            ),
        arrivals: {
            scheduled: scheduledArrivals,
            checkedIn: checkedInArrivals,
            pending: Math.max(
                0,
                scheduledArrivals - checkedInArrivals
            ),
        },
        departures: {
            scheduled: scheduledDepartures,
        },
        pendingPayments,
        occupancy: shapeOccupancy({
            stays: facet.occupancyStays,
            occupiedTodayRows: facet.occupiedToday,
            roomInventory,
            analyticsRange,
        }),
        ...lifecycleResult,
        roomTypePerformance,
    }
}
