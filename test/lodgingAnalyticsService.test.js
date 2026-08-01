import assert from "node:assert/strict"
import test from "node:test"
import {
    LODGING_ACTIVE_PENDING_PAYMENT_STATUSES,
    LODGING_INVENTORY_BLOCKING_STATUSES,
    LODGING_NON_SERVICE_TERMINAL_STATUSES,
    LODGING_SCHEDULED_STAY_STATUSES,
    LODGING_STAY_LENGTH_STATUSES,
    getLodgingAnalytics as getLodgingAnalyticsService,
} from "../src/services/analytics/lodgingAnalyticsService.js"

const EMPTY_PHASE_4_ANALYTICS = {
    lifecycle: {
        confirmations: {
            count: 0,
            comparisonPercent: 0,
        },
        cancellations: {
            count: 0,
            cancelledBookingCohortRatePercent:
                null,
            comparisonPercent: 0,
        },
        checkouts: {
            actualCount: 0,
            scheduledCount: 0,
            completedScheduledCount: 0,
            completionRatePercent: null,
        },
    },
    confirmationTrend: [],
    cancellationTrend: [],
    cancellationReasonBreakdown: [],
    checkoutTrend: [],
    checkInStaffPerformance: [],
    checkOutStaffPerformance: [],
    staffAttribution: {
        unattributedCheckIns: 0,
        unattributedCheckOuts: 0,
    },
}

function getLodgingAnalytics(input) {
    return getLodgingAnalyticsService({
        lifecycleAnalytics: async () =>
            EMPTY_PHASE_4_ANALYTICS,
        roomTypeAnalytics: async () => [],
        ...input,
    })
}

const businessId = "hotel_1"
const analyticsRange = {
    preset: "7days",
    timezone: "Europe/Berlin",
    from: "2026-07-22",
    to: "2026-07-28",
    startUtc: new Date("2026-07-21T22:00:00.000Z"),
    endUtcExclusive: new Date("2026-07-28T22:00:00.000Z"),
    comparison: {
        from: "2026-07-15",
        to: "2026-07-21",
        startUtc: new Date("2026-07-14T22:00:00.000Z"),
        endUtcExclusive: new Date("2026-07-21T22:00:00.000Z"),
    },
}
const generatedAt = new Date("2026-07-28T12:00:00.000Z")
const financials = {
    current: {
        grossCents: 60000,
        refundedCents: 0,
        netRetainedCents: 60000,
        netToBusinessCents: 55000,
        transactionCount: 2,
        averageTransactionValueCents: 30000,
    },
    comparison: {
        grossCents: 50000,
        refundedCents: 0,
        netRetainedCents: 50000,
        netToBusinessCents: 46000,
        transactionCount: 2,
        averageTransactionValueCents: 25000,
    },
    revenueByDay: [
        {
            date: "2026-07-22",
            grossCents: 30000,
            refundedCents: 0,
            netRetainedCents: 30000,
            transactionCount: 1,
        },
        {
            date: "2026-07-28",
            grossCents: 30000,
            refundedCents: 0,
            netRetainedCents: 30000,
            transactionCount: 1,
        },
    ],
    averageTransactionValueComparisonPercent: 20,
}

function createModels({ empty = false } = {}) {
    const reservationPipelines = []
    const servicePointQueries = []

    const mainFacet = empty
        ? {}
        : {
              bookingTrend: [
                  {
                      _id: "2026-07-22",
                      bookingCount: 2,
                  },
              ],
              reservationStatusBreakdown: [
                  { _id: "confirmed", count: 2 },
                  { _id: "cancelled", count: 1 },
              ],
              paymentStatusBreakdown: [
                  { _id: "paid", count: 2 },
                  { _id: "pending", count: 1 },
              ],
              bookingSourceBreakdown: [
                  { _id: "public_hub", count: 3 },
              ],
              stayLength: [
                  {
                      totalNights: 5,
                      stayCount: 2,
                  },
              ],
              arrivals: [
                  {
                      scheduled: 3,
                      checkedIn: 1,
                  },
              ],
              departures: [{ scheduled: 2 }],
              actualCheckIns: [{ count: 1 }],
              roomRevenuePerformance: [
                  {
                      _id: "sp_room_1",
                      displayLabel: "Old Room Label",
                      paidBookingCount: 2,
                      paidRevenueCents: 60000,
                      totalNights: 5,
                  },
              ],
              occupancyStays: [
                  {
                      servicePointId: "sp_room_1",
                      checkInDate: "2026-07-22",
                      checkOutDate: "2026-07-24",
                  },
                  {
                      // Duplicate/overlapping records cannot inflate a
                      // room-night beyond one occupied room on one date.
                      servicePointId: "sp_room_1",
                      checkInDate: "2026-07-22",
                      checkOutDate: "2026-07-24",
                  },
                  {
                      servicePointId: "sp_room_2",
                      checkInDate: "2026-07-27",
                      checkOutDate: "2026-07-29",
                  },
                  {
                      servicePointId: "sp_table_1",
                      checkInDate: "2026-07-22",
                      checkOutDate: "2026-07-24",
                  },
              ],
              occupiedToday: [
                  { _id: "sp_room_2" },
                  { _id: "sp_table_1" },
              ],
          }
    const pendingFacet = empty
        ? {}
        : {
              active: [
                  {
                      count: 1,
                      valueCents: 30000,
                  },
              ],
              expired: [
                  {
                      count: 1,
                      valueCents: 20000,
                  },
              ],
          }

    return {
        reservationPipelines,
        servicePointQueries,
        reservationModel: {
            async aggregate(pipeline) {
                reservationPipelines.push(pipeline)
                const facet =
                    pipeline[pipeline.length - 1].$facet
                return [
                    facet.bookingTrend
                        ? mainFacet
                        : pendingFacet,
                ]
            },
        },
        servicePointModel: {
            find(filter, projection) {
                servicePointQueries.push({
                    filter,
                    projection,
                })
                return {
                    lean: async () =>
                        empty
                            ? []
                            : [
                                  {
                                      servicePointId:
                                          "sp_room_1",
                                      label: "Room 101",
                                      code: "101",
                                      servicePointType:
                                          "room",
                                      isActive: true,
                                      reservable: true,
                                  },
                                  {
                                      servicePointId:
                                          "sp_room_2",
                                      label: "Room 102",
                                      code: "102",
                                      servicePointType:
                                          "room",
                                      isActive: true,
                                      reservable: true,
                                  },
                                  {
                                      servicePointId:
                                          "sp_table_1",
                                      label: "Table 1",
                                      code: "T1",
                                      servicePointType:
                                          "table",
                                      isActive: true,
                                      reservable: true,
                                  },
                              ],
                }
            },
        },
    }
}

test("lodging analytics shapes reliable revenue, stay, arrival, pending, and room metrics", async () => {
    const models = createModels()
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.deepEqual(result.overview, {
        paidBookingRevenueCents: 60000,
        refundedBookingRevenueCents: 0,
        netRetainedBookingRevenueCents: 60000,
        paidBookingRevenueComparisonPercent: 20,
        paidBookingCount: 2,
        averageBookingValueCents: 30000,
        averageBookingValueComparisonPercent: 20,
        averageLengthOfStayNights: 2.5,
        scheduledArrivals: 3,
        scheduledDepartures: 2,
        actualCheckIns: 1,
        pendingPaymentCount: 1,
        pendingPaymentValueCents: 30000,
    })
    assert.deepEqual(result.bookingRevenueByDay[0], {
        date: "2026-07-22",
        grossCents: 30000,
        refundedCents: 0,
        netRetainedCents: 30000,
        bookingCount: 1,
    })
    assert.equal(result.bookingTrend.length, 7)
    assert.deepEqual(result.bookingTrend[0], {
        date: "2026-07-22",
        bookingCount: 2,
    })
    assert.deepEqual(result.arrivals, {
        scheduled: 3,
        checkedIn: 1,
        pending: 2,
    })
    assert.deepEqual(result.departures, {
        scheduled: 2,
    })
    assert.deepEqual(result.pendingPayments, {
        activeCount: 1,
        expiredCount: 1,
        activeValueCents: 30000,
        expiredValueCents: 20000,
        snapshotAt: generatedAt.toISOString(),
    })
})

test("lodging overview distinguishes gross collected, successful refunds, and net retained", async () => {
    const models = createModels()
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials: {
            ...financials,
            current: {
                ...financials.current,
                refundedCents: 12000,
                netRetainedCents: 48000,
            },
            revenueByDay: financials.revenueByDay.map(
                (row, index) => ({
                    ...row,
                    refundedCents: index === 0 ? 12000 : 0,
                    netRetainedCents:
                        row.grossCents -
                        (index === 0 ? 12000 : 0),
                }),
            ),
        },
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.equal(result.overview.paidBookingRevenueCents, 60000)
    assert.equal(result.overview.refundedBookingRevenueCents, 12000)
    assert.equal(
        result.overview.netRetainedBookingRevenueCents,
        48000,
    )
    assert.deepEqual(result.bookingRevenueByDay[0], {
        date: "2026-07-22",
        grossCents: 30000,
        refundedCents: 12000,
        netRetainedCents: 18000,
        bookingCount: 1,
    })
})

test("breakdowns retain canonical stored values and explicit percentage fields", async () => {
    const models = createModels()
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.deepEqual(
        result.reservationStatusBreakdown,
        [
            {
                status: "confirmed",
                count: 2,
                percentagePercent: 66.7,
            },
            {
                status: "cancelled",
                count: 1,
                percentagePercent: 33.3,
            },
        ]
    )
    assert.deepEqual(
        result.paymentStatusBreakdown[0],
        {
            status: "paid",
            count: 2,
            percentagePercent: 66.7,
        }
    )
    assert.deepEqual(
        result.bookingSourceBreakdown,
        [
            {
                source: "public_hub",
                count: 3,
                percentagePercent: 100,
            },
        ]
    )
})

test("room performance is enriched once with tenant-scoped ServicePoint metadata", async () => {
    const models = createModels()
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.deepEqual(
        result.roomRevenuePerformance,
        [
            {
                servicePointId: "sp_room_1",
                label: "Room 101",
                code: "101",
                paidBookingCount: 2,
                paidRevenueCents: 60000,
                averageBookingValueCents: 30000,
                totalNights: 5,
            },
        ]
    )
    assert.equal(
        models.servicePointQueries.length,
        1
    )
    assert.equal(
        models.servicePointQueries[0].filter.businessId,
        businessId
    )
})

test("occupancy uses current active reservable room inventory and excludes hybrid tables", async () => {
    const models = createModels()
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.deepEqual(result.occupancy, {
        occupiedRoomNights: 4,
        availableRoomNights: 14,
        occupancyRatePercent: 28.6,
        occupiedRoomsForToday: 1,
        availableRoomsForToday: 1,
    })
})

test("lodging pipelines are tenant scoped and use separate date bases", async () => {
    const models = createModels()
    await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    const [mainPipeline, pendingPipeline] =
        models.reservationPipelines
    assert.equal(
        mainPipeline[0].$match.businessId,
        businessId
    )
    assert.ok(mainPipeline[0].$match.checkInDate.$regex)
    assert.ok(mainPipeline[0].$match.checkOutDate.$regex)
    assert.equal(
        pendingPipeline[0].$match.businessId,
        businessId
    )

    const facets =
        mainPipeline[mainPipeline.length - 1].$facet
    assert.deepEqual(
        facets.bookingTrend[0].$match.createdAt,
        {
            $gte: analyticsRange.startUtc,
            $lt: analyticsRange.endUtcExclusive,
        }
    )
    assert.deepEqual(
        facets.actualCheckIns[0].$match.checkedInAt,
        {
            $gte: analyticsRange.startUtc,
            $lt: analyticsRange.endUtcExclusive,
        }
    )
    assert.deepEqual(
        facets.arrivals[0].$match.checkInDate,
        {
            $gte: analyticsRange.from,
            $lte: analyticsRange.to,
        }
    )
})

test("lifecycle sets exclude cancelled terminal bookings from scheduled and pending populations", () => {
    for (const status of LODGING_NON_SERVICE_TERMINAL_STATUSES) {
        assert.equal(
            LODGING_SCHEDULED_STAY_STATUSES.includes(
                status
            ),
            false
        )
        assert.equal(
            LODGING_ACTIVE_PENDING_PAYMENT_STATUSES.includes(
                status
            ),
            false
        )
        assert.equal(
            LODGING_INVENTORY_BLOCKING_STATUSES.includes(
                status
            ),
            false
        )
    }
    assert.equal(
        LODGING_STAY_LENGTH_STATUSES.includes("cancelled"),
        false
    )
})

test("enabled lodging with no activity returns zeros, empty domain arrays, and safe zero-inventory occupancy", async () => {
    const models = createModels({ empty: true })
    const emptyFinancials = {
        current: {
            grossCents: 0,
            netToBusinessCents: 0,
            transactionCount: 0,
            averageTransactionValueCents: 0,
        },
        comparison: {
            grossCents: 0,
            netToBusinessCents: 0,
            transactionCount: 0,
            averageTransactionValueCents: 0,
        },
        revenueByDay: [],
        averageTransactionValueComparisonPercent: 0,
    }
    const result = await getLodgingAnalytics({
        businessId,
        analyticsRange,
        financials: emptyFinancials,
        generatedAt,
        reservationModel: models.reservationModel,
        servicePointModel: models.servicePointModel,
    })

    assert.equal(result.overview.paidBookingCount, 0)
    assert.equal(result.overview.scheduledArrivals, 0)
    assert.deepEqual(result.bookingRevenueByDay, [])
    assert.deepEqual(result.bookingTrend, [])
    assert.deepEqual(
        result.reservationStatusBreakdown,
        []
    )
    assert.deepEqual(result.roomRevenuePerformance, [])
    assert.deepEqual(result.occupancy, {
        occupiedRoomNights: 0,
        availableRoomNights: 0,
        occupancyRatePercent: null,
        occupiedRoomsForToday: 0,
        availableRoomsForToday: 0,
    })
})

test("lodging analytics requires shared financial facts", async () => {
    await assert.rejects(
        () =>
            getLodgingAnalytics({
                businessId,
                analyticsRange,
                generatedAt,
                reservationModel: {},
                servicePointModel: {},
            }),
        /financial facts/
    )
})
