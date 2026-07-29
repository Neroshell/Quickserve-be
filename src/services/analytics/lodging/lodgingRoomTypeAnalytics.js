import { DateTime } from "luxon"
import Reservation from "../../../models/Reservation.js"
import ServicePoint from "../../../models/ServicePoint.js"
import {
    buildReservationAnalyticsFinancialFields,
    getLodgingStayMatch,
} from "../sharedAnalyticsService.js"
import { enumerateAnalyticsLocalDates } from "../analyticsRangeService.js"
import { LODGING_ROOM_TYPE_STAY_STATUSES } from "./lodgingAnalyticsConstants.js"

const UNCATEGORIZED_ROOM_TYPE = "Uncategorized"

function currentInterval(analyticsRange) {
    return {
        $gte: analyticsRange.startUtc,
        $lt: analyticsRange.endUtcExclusive,
    }
}

function intervalEndDate(analyticsRange) {
    return DateTime.fromISO(analyticsRange.to, {
        zone: analyticsRange.timezone,
    })
        .plus({ days: 1 })
        .toISODate()
}

function buildPaidRoomTypePipeline({
    businessId,
    analyticsRange,
}) {
    return [
        {
            $match: {
                businessId,
                paymentStatus: "paid",
                paidAt: currentInterval(analyticsRange),
                ...getLodgingStayMatch(),
                servicePointId: { $ne: null },
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
            $group: {
                _id: {
                    servicePointId: "$servicePointId",
                    roomTypeSnapshot:
                        "$roomTypeSnapshot",
                },
                paidBookingCount: { $sum: 1 },
                paidRevenueCents: {
                    $sum: "$analyticsGrossCents",
                },
            },
        },
    ]
}

function buildBookedStayPipeline({
    businessId,
    analyticsRange,
}) {
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
                status: {
                    $in: LODGING_ROOM_TYPE_STAY_STATUSES,
                },
                checkInDate: {
                    $lt: intervalEndDate(analyticsRange),
                },
                checkOutDate: {
                    $gt: analyticsRange.from,
                },
                servicePointId: { $ne: null },
            },
        },
        {
            $project: {
                _id: 0,
                servicePointId: 1,
                roomTypeSnapshot: 1,
                checkInDate: 1,
                checkOutDate: 1,
            },
        },
    ]
}

async function loadRoomServicePoints({
    businessId,
    servicePointModel,
}) {
    const query = servicePointModel.find(
        {
            businessId,
            servicePointType: "room",
        },
        "servicePointId roomType servicePointType isActive reservable"
    )
    return typeof query?.lean === "function"
        ? query.lean()
        : query
}

function normalizedRoomType(value) {
    const label = String(value || "")
        .trim()
        .replace(/\s+/g, " ")
    const display = label || UNCATEGORIZED_ROOM_TYPE
    return {
        key: display.toLocaleLowerCase(),
        display,
    }
}

function integer(value) {
    const parsed = Number(value || 0)
    return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function roomNightKeys({
    servicePointId,
    checkInDate,
    checkOutDate,
    analyticsRange,
}) {
    const timezone = analyticsRange.timezone
    const checkIn = DateTime.fromISO(checkInDate, {
        zone: timezone,
    }).startOf("day")
    const checkOut = DateTime.fromISO(checkOutDate, {
        zone: timezone,
    }).startOf("day")
    const from = DateTime.fromISO(analyticsRange.from, {
        zone: timezone,
    }).startOf("day")
    const to = DateTime.fromISO(
        intervalEndDate(analyticsRange),
        { zone: timezone }
    ).startOf("day")

    if (
        !checkIn.isValid ||
        !checkOut.isValid ||
        checkOut <= checkIn
    ) {
        return []
    }

    let date = checkIn > from ? checkIn : from
    const end = checkOut < to ? checkOut : to
    const keys = []
    while (date < end) {
        keys.push(
            `${servicePointId}:${date.toISODate()}`
        )
        date = date.plus({ days: 1 })
    }
    return keys
}

function ensureType(groups, typeValue) {
    const normalized = normalizedRoomType(typeValue)
    if (!groups.has(normalized.key)) {
        groups.set(normalized.key, {
            roomType: normalized.display,
            roomCount: 0,
            paidBookingCount: 0,
            paidRevenueCents: 0,
            roomNightKeys: new Set(),
        })
    }
    return groups.get(normalized.key)
}

export async function getLodgingRoomTypeAnalytics({
    businessId,
    analyticsRange,
    reservationModel = Reservation,
    servicePointModel = ServicePoint,
}) {
    const [paidRows, bookedStays, servicePoints] =
        await Promise.all([
            reservationModel.aggregate(
                buildPaidRoomTypePipeline({
                    businessId,
                    analyticsRange,
                })
            ),
            reservationModel.aggregate(
                buildBookedStayPipeline({
                    businessId,
                    analyticsRange,
                })
            ),
            loadRoomServicePoints({
                businessId,
                servicePointModel,
            }),
        ])

    const servicePointMetadata = new Map(
        (servicePoints || []).map((servicePoint) => [
            servicePoint.servicePointId,
            servicePoint,
        ])
    )
    const groups = new Map()

    for (const servicePoint of servicePoints || []) {
        if (
            servicePoint.isActive !== true ||
            servicePoint.reservable !== true
        ) {
            continue
        }
        ensureType(groups, servicePoint.roomType)
            .roomCount += 1
    }

    for (const row of paidRows || []) {
        const servicePointId =
            row._id?.servicePointId
        const servicePoint =
            servicePointMetadata.get(servicePointId)
        const typeValue =
            row._id?.roomTypeSnapshot ||
            servicePoint?.roomType
        const group = ensureType(groups, typeValue)
        group.paidBookingCount += integer(
            row.paidBookingCount
        )
        group.paidRevenueCents += integer(
            row.paidRevenueCents
        )
    }

    for (const stay of bookedStays || []) {
        const servicePoint =
            servicePointMetadata.get(
                stay.servicePointId
            )
        const typeValue =
            stay.roomTypeSnapshot ||
            servicePoint?.roomType
        const group = ensureType(groups, typeValue)
        for (const key of roomNightKeys({
            ...stay,
            analyticsRange,
        })) {
            group.roomNightKeys.add(key)
        }
    }

    const selectedDayCount =
        enumerateAnalyticsLocalDates(analyticsRange).length

    return Array.from(groups.values())
        .map((group) => {
            const bookedNights =
                group.roomNightKeys.size
            const availableRoomNights =
                group.roomCount * selectedDayCount
            return {
                roomType: group.roomType,
                roomCount: group.roomCount,
                paidBookingCount:
                    group.paidBookingCount,
                bookedNights,
                paidRevenueCents:
                    group.paidRevenueCents,
                averageBookingValueCents:
                    group.paidBookingCount > 0
                        ? Math.round(
                              group.paidRevenueCents /
                                  group.paidBookingCount
                          )
                        : 0,
                occupancyRatePercent:
                    availableRoomNights > 0
                        ? Math.round(
                              (bookedNights /
                                  availableRoomNights) *
                                  1000
                          ) / 10
                        : null,
            }
        })
        .sort(
            (first, second) =>
                second.paidRevenueCents -
                    first.paidRevenueCents ||
                first.roomType.localeCompare(
                    second.roomType
                )
        )
}
