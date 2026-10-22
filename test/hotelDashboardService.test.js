import assert from "node:assert/strict"
import test from "node:test"

import {
    buildHotelDashboardReservationPipeline,
    createHotelDashboardService,
} from "../src/services/dashboard/hotelDashboardService.js"

const range = {
    lodgingCalendarRange: {
        from: "2026-10-22",
        timezone: "Europe/Berlin",
        startUtc: new Date("2026-10-21T22:00:00.000Z"),
        endUtcExclusive: new Date("2026-10-22T22:00:00.000Z"),
    },
    foodOperationalRange: {
        startUtc: new Date("2026-10-22T00:00:00.000Z"),
        endUtcExclusive: new Date("2026-10-23T00:00:00.000Z"),
    },
}

const business = {
    businessId: "hotel_dashboard_alpha",
    currency: "eur",
    stripeChargesEnabled: true,
    billingStatus: "active",
}

test("hotel dashboard scopes every enabled domain query to its business", async () => {
    const queries = []
    const reservationPipelines = []
    let orderCount = 0
    const service = createHotelDashboardService({
        reservationModel: {
            async aggregate(pipeline) {
                reservationPipelines.push(pipeline)
                return [{
                    arrivals: [{ scheduled: 4, checkedIn: 1 }],
                    departures: [{ scheduled: 3, checkedOut: 2 }],
                    occupiedRooms: [{ _id: "room-101" }],
                    overdueArrivals: [{ count: 1 }],
                    overdueDepartures: [{ count: 2 }],
                    activePendingPayments: [{ count: 3 }],
                }]
            },
        },
        servicePointModel: {
            find(filter) {
                queries.push(filter)
                return { lean: async () => [{ servicePointId: "room-101" }, { servicePointId: "room-102" }] }
            },
            async countDocuments(filter) {
                queries.push(filter)
                if (filter["roomReadiness.state"]) return 4
                return 0
            },
        },
        housekeepingOperationModel: {
            async countDocuments(filter) {
                queries.push(filter)
                return filter.priority === "urgent" ? 2 : 1
            },
        },
        orderModel: {
            async countDocuments(filter) {
                queries.push(filter)
                orderCount += 1
                return orderCount === 1 ? 9 : 3
            },
        },
        rangeResolver: () => range,
        sharedAnalytics: async (input) => {
            assert.equal(input.businessId, business.businessId)
            assert.deepEqual(input.enabledAnalyticsModules, ["lodging", "foodService"])
            return {
                lodgingFinancials: { current: { grossCents: 4567, transactionCount: 5 } },
                foodServiceFinancials: { current: { grossCents: 1200 } },
            }
        },
        clock: () => new Date("2026-10-22T10:00:00.000Z"),
    })

    const result = await service({
        business,
        hasFoodService: true,
        access: {
            reservations: true,
            housekeeping: true,
            transactions: true,
            foodServiceOrders: true,
            servicePoints: true,
            staff: true,
            billing: true,
        },
    })

    assert.equal(result.dashboardType, "hotel")
    assert.equal(result.currency, "EUR")
    assert.deepEqual(result.operations.arrivals, { scheduled: 4, checkedIn: 1, remaining: 3 })
    assert.deepEqual(result.operations.departures, { scheduled: 3, checkedOut: 2, remaining: 1 })
    assert.deepEqual(result.operations.roomInventory, { eligibleRooms: 2, occupiedRooms: 1, notCurrentlyOccupiedRooms: 1 })
    assert.deepEqual(result.housekeeping, {
        roomsNeedingCleaning: 4,
        urgentTasks: 2,
        unresolvedInventoryExceptions: 1,
    })
    assert.deepEqual(result.financialSummary, {
        paidBookingRevenueCents: 4567,
        paidBookingCount: 5,
        pendingReservationPaymentCount: 3,
    })
    assert.deepEqual(result.foodService, { todayOrders: 9, activeOrders: 3, paidRevenueCents: 1200 })
    assert.equal(result.actionItems.length, 6)
    assert.equal(reservationPipelines[0][0].$match.businessId, business.businessId)
    assert.deepEqual(reservationPipelines[0][1].$facet.occupiedRooms[0].$match.servicePointId.$in, ["room-101", "room-102"])
    queries.forEach((filter) => assert.equal(filter.businessId, business.businessId))
})

test("hotel dashboard does not query or expose domains the requester cannot access", async () => {
    const forbiddenModel = new Proxy({}, {
        get() {
            return () => { throw new Error("Unauthorized dashboard domain was queried") }
        },
    })
    const service = createHotelDashboardService({
        reservationModel: forbiddenModel,
        servicePointModel: forbiddenModel,
        housekeepingOperationModel: forbiddenModel,
        orderModel: forbiddenModel,
        rangeResolver: () => range,
        sharedAnalytics: async () => { throw new Error("Unauthorized financial domain was queried") },
        clock: () => new Date("2026-10-22T10:00:00.000Z"),
    })

    const result = await service({ business, hasFoodService: true, access: {} })

    assert.equal(result.operations, null)
    assert.equal(result.housekeeping, null)
    assert.equal(result.financialSummary, null)
    assert.equal(result.foodService, null)
    assert.equal(result.businessHealth, null)
    assert.deepEqual(result.actionItems, [])
    assert.deepEqual(result.access, {
        reservations: false,
        housekeeping: false,
        transactions: false,
        servicePoints: false,
        staff: false,
        billing: false,
        foodService: false,
    })
})

test("hotel dashboard reservation pipeline includes only active lodging status cohorts", () => {
    const pipeline = buildHotelDashboardReservationPipeline({
        businessId: business.businessId,
        businessDate: range.lodgingCalendarRange.from,
        lodgingRange: range.lodgingCalendarRange,
        now: new Date("2026-10-22T10:00:00.000Z"),
        eligibleRoomIds: ["room-101"],
    })

    assert.equal(pipeline[0].$match.businessId, business.businessId)
    assert.deepEqual(pipeline[1].$facet.occupiedRooms[0].$match.servicePointId.$in, ["room-101"])
    assert.deepEqual(pipeline[1].$facet.activePendingPayments[0].$match.paymentStatus, "pending")
})
