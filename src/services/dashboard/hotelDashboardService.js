import Reservation from "../../models/Reservation.js"
import ServicePoint from "../../models/ServicePoint.js"
import HousekeepingOperation from "../../models/HousekeepingOperation.js"
import Order from "../../models/order.js"
import { resolveAnalyticsDomainRanges } from "../analytics/analyticsRangeService.js"
import { getSharedAnalytics, getLodgingStayMatch } from "../analytics/sharedAnalyticsService.js"
import {
    LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
    LODGING_SCHEDULED_STAY_STATUSES,
} from "../analytics/lodging/lodgingAnalyticsConstants.js"

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.round(number) : 0
}

async function lean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

function first(rows) {
    return rows?.[0] || {}
}

export function buildHotelDashboardReservationPipeline({
    businessId,
    businessDate,
    lodgingRange,
    now,
    eligibleRoomIds,
}) {
    return [
        {
            $match: {
                businessId,
                ...getLodgingStayMatch(),
            },
        },
        {
            $facet: {
                arrivals: [
                    {
                        $match: {
                            checkInDate: businessDate,
                            status: { $in: LODGING_SCHEDULED_STAY_STATUSES },
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
                                            $and: [
                                                { $gte: ["$checkedInAt", lodgingRange.startUtc] },
                                                { $lt: ["$checkedInAt", lodgingRange.endUtcExclusive] },
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
                            checkOutDate: businessDate,
                            status: { $in: LODGING_SCHEDULED_STAY_STATUSES },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            scheduled: { $sum: 1 },
                            checkedOut: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gte: ["$checkedOutAt", lodgingRange.startUtc] },
                                                { $lt: ["$checkedOutAt", lodgingRange.endUtcExclusive] },
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
                occupiedRooms: [
                    {
                        $match: {
                            status: "checked_in",
                            checkInDate: { $lte: businessDate },
                            checkOutDate: { $gt: businessDate },
                            servicePointId: { $in: eligibleRoomIds },
                        },
                    },
                    { $group: { _id: "$servicePointId" } },
                ],
                overdueArrivals: [
                    {
                        $match: {
                            status: "confirmed",
                            checkInDate: { $lt: businessDate },
                        },
                    },
                    { $count: "count" },
                ],
                overdueDepartures: [
                    {
                        $match: {
                            status: "checked_in",
                            checkOutDate: { $lt: businessDate },
                        },
                    },
                    { $count: "count" },
                ],
                activePendingPayments: [
                    {
                        $match: {
                            paymentStatus: "pending",
                            status: { $in: LODGING_ACTIVE_PENDING_PAYMENT_STATUSES },
                            paymentExpiresAt: { $gt: now },
                        },
                    },
                    { $count: "count" },
                ],
            },
        },
    ]
}

function buildAttention({ operations, housekeeping, billing }) {
    const items = []
    if (operations?.overdueArrivals > 0) {
        items.push({
            type: "arrival",
            severity: "warning",
            message: `${operations.overdueArrivals} overdue arrival${operations.overdueArrivals === 1 ? "" : "s"} need attention.`,
            href: "/owner/reservations",
        })
    }
    if (operations?.overdueDepartures > 0) {
        items.push({
            type: "departure",
            severity: "warning",
            message: `${operations.overdueDepartures} overdue departure${operations.overdueDepartures === 1 ? "" : "s"} need attention.`,
            href: "/owner/reservations",
        })
    }
    if (operations?.activePendingPayments > 0) {
        items.push({
            type: "payment",
            severity: "warning",
            message: `${operations.activePendingPayments} reservation payment${operations.activePendingPayments === 1 ? "" : "s"} remain pending.`,
            href: "/owner/reservations",
        })
    }
    if (housekeeping?.urgentTasks > 0) {
        items.push({
            type: "housekeeping",
            severity: "error",
            message: `${housekeeping.urgentTasks} urgent housekeeping task${housekeeping.urgentTasks === 1 ? "" : "s"} need attention.`,
            href: "/housekeeping",
        })
    }
    if (housekeeping?.roomsNeedingCleaning > 0) {
        items.push({
            type: "housekeeping",
            severity: "warning",
            message: `${housekeeping.roomsNeedingCleaning} room${housekeeping.roomsNeedingCleaning === 1 ? "" : "s"} need cleaning.`,
            href: "/housekeeping",
        })
    }
    if (housekeeping?.unresolvedInventoryExceptions > 0) {
        items.push({
            type: "inventory",
            severity: "warning",
            message: `${housekeeping.unresolvedInventoryExceptions} housekeeping inventory exception${housekeeping.unresolvedInventoryExceptions === 1 ? "" : "s"} remain unresolved.`,
            href: "/housekeeping",
        })
    }
    if (billing?.billing === "incomplete") {
        items.push({
            type: "billing",
            severity: "error",
            message: "Billing setup is incomplete.",
            href: "/owner/billing",
        })
    } else if (billing?.billing === "past_due") {
        items.push({
            type: "billing",
            severity: "error",
            message: "Billing is past due.",
            href: "/owner/billing",
        })
    }
    if (billing?.onlinePayments === "not_configured") {
        items.push({
            type: "payments",
            severity: "warning",
            message: "Online payments are not configured.",
            href: "/owner/billing",
        })
    }
    return items
}

export function createHotelDashboardService({
    reservationModel = Reservation,
    servicePointModel = ServicePoint,
    housekeepingOperationModel = HousekeepingOperation,
    orderModel = Order,
    rangeResolver = resolveAnalyticsDomainRanges,
    sharedAnalytics = getSharedAnalytics,
    clock = () => new Date(),
} = {}) {
    return async function getHotelDashboard({
        business,
        access,
        hasFoodService = false,
    }) {
        const businessId = business?.businessId
        if (!businessId) throw new TypeError("businessId is required")

        const now = clock()
        const { lodgingCalendarRange, foodOperationalRange } = rangeResolver({
            preset: "today",
            now,
            business,
        })
        const businessDate = lodgingCalendarRange.from
        const canReadReservations = Boolean(access?.reservations)
        const canReadHousekeeping = Boolean(access?.housekeeping)
        const canReadTransactions = Boolean(access?.transactions)
        const canReadFoodOrders = Boolean(access?.foodServiceOrders)
        const canReadFoodService = hasFoodService && (canReadTransactions || canReadFoodOrders)

        const eligibleRooms = canReadReservations
            ? await lean(servicePointModel.find({
                businessId,
                servicePointType: "room",
                isActive: true,
                reservable: true,
            }, "servicePointId")) || []
            : []
        const eligibleRoomIds = eligibleRooms.map((room) => room.servicePointId)

        const financialModules = canReadTransactions
            ? ["lodging", ...(hasFoodService ? ["foodService"] : [])]
            : []
        const [reservationFacets, housekeepingResults, financialResult, foodOrderCounts] = await Promise.all([
            canReadReservations
                ? reservationModel.aggregate(buildHotelDashboardReservationPipeline({
                    businessId,
                    businessDate,
                    lodgingRange: lodgingCalendarRange,
                    now,
                    eligibleRoomIds,
                }))
                : Promise.resolve([]),
            canReadHousekeeping
                ? Promise.all([
                    servicePointModel.countDocuments({
                        businessId,
                        servicePointType: "room",
                        "roomReadiness.state": "needs_cleaning",
                    }),
                    housekeepingOperationModel.countDocuments({
                        businessId,
                        active: true,
                        priority: "urgent",
                    }),
                    housekeepingOperationModel.countDocuments({
                        businessId,
                        "inventoryException.status": "unresolved",
                    }),
                ])
                : Promise.resolve(null),
            financialModules.length
                ? sharedAnalytics({
                    businessId,
                    enabledAnalyticsModules: financialModules,
                    foodOperationalRange,
                    lodgingCalendarRange,
                })
                : Promise.resolve(null),
            hasFoodService && canReadFoodOrders
                ? Promise.all([
                    orderModel.countDocuments({
                        businessId,
                        createdAt: {
                            $gte: foodOperationalRange.startUtc,
                            $lt: foodOperationalRange.endUtcExclusive,
                        },
                        status: { $in: ["placed", "in_progress", "ready", "completed"] },
                    }),
                    orderModel.countDocuments({
                        businessId,
                        createdAt: {
                            $gte: foodOperationalRange.startUtc,
                            $lt: foodOperationalRange.endUtcExclusive,
                        },
                        status: { $in: ["placed", "in_progress", "ready"] },
                    }),
                ])
                : Promise.resolve(null),
        ])

        const facet = first(reservationFacets)
        const arrivals = first(facet.arrivals)
        const departures = first(facet.departures)
        const occupiedRoomCount = (facet.occupiedRooms || []).length
        const operations = canReadReservations
            ? {
                arrivals: {
                    scheduled: integer(arrivals.scheduled),
                    checkedIn: integer(arrivals.checkedIn),
                    remaining: Math.max(0, integer(arrivals.scheduled) - integer(arrivals.checkedIn)),
                },
                departures: {
                    scheduled: integer(departures.scheduled),
                    checkedOut: integer(departures.checkedOut),
                    remaining: Math.max(0, integer(departures.scheduled) - integer(departures.checkedOut)),
                },
                roomInventory: {
                    eligibleRooms: eligibleRoomIds.length,
                    occupiedRooms: occupiedRoomCount,
                    notCurrentlyOccupiedRooms: Math.max(0, eligibleRoomIds.length - occupiedRoomCount),
                },
                overdueArrivals: integer(first(facet.overdueArrivals).count),
                overdueDepartures: integer(first(facet.overdueDepartures).count),
                activePendingPayments: integer(first(facet.activePendingPayments).count),
            }
            : null
        const housekeeping = housekeepingResults
            ? {
                roomsNeedingCleaning: integer(housekeepingResults[0]),
                urgentTasks: integer(housekeepingResults[1]),
                unresolvedInventoryExceptions: integer(housekeepingResults[2]),
            }
            : null
        const lodgingFinancials = financialResult?.lodgingFinancials?.current
        const foodFinancials = financialResult?.foodServiceFinancials?.current
        const financialSummary = canReadTransactions
            ? {
                paidBookingRevenueCents: integer(lodgingFinancials?.grossCents),
                paidBookingCount: integer(lodgingFinancials?.transactionCount),
                pendingReservationPaymentCount: operations?.activePendingPayments ?? null,
            }
            : null
        const foodService = canReadFoodService
            ? {
                todayOrders: foodOrderCounts ? integer(foodOrderCounts[0]) : null,
                activeOrders: foodOrderCounts ? integer(foodOrderCounts[1]) : null,
                paidRevenueCents: canReadTransactions ? integer(foodFinancials?.grossCents) : null,
            }
            : null
        const billing = access?.billing
            ? {
                onlinePayments: business.stripeChargesEnabled === true ? "active" : "not_configured",
                billing: business.billingStatus || "incomplete",
            }
            : null

        return {
            dashboardType: "hotel",
            generatedAt: now.toISOString(),
            businessDate,
            timezone: lodgingCalendarRange.timezone,
            currency: typeof business.currency === "string" ? business.currency.trim().toUpperCase() : null,
            access: {
                reservations: canReadReservations,
                housekeeping: canReadHousekeeping,
                transactions: canReadTransactions,
                servicePoints: Boolean(access?.servicePoints),
                staff: Boolean(access?.staff),
                billing: Boolean(access?.billing),
                foodService: canReadFoodService,
            },
            operations,
            housekeeping,
            financialSummary,
            foodService,
            businessHealth: billing,
            actionItems: buildAttention({ operations, housekeeping, billing }),
        }
    }
}

export const hotelDashboardService = createHotelDashboardService()
