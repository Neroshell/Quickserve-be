import assert from "node:assert/strict"
import test from "node:test"
import { getLodgingLifecycleAnalytics } from "../src/services/analytics/lodging/lodgingLifecycleAnalytics.js"

const analyticsRange = {
    preset: "custom",
    timezone: "Europe/Berlin",
    from: "2026-07-28",
    to: "2026-07-30",
    startUtc: new Date("2026-07-27T22:00:00.000Z"),
    endUtcExclusive: new Date(
        "2026-07-30T22:00:00.000Z"
    ),
    comparison: {
        from: "2026-07-25",
        to: "2026-07-27",
        startUtc: new Date(
            "2026-07-24T22:00:00.000Z"
        ),
        endUtcExclusive: new Date(
            "2026-07-27T22:00:00.000Z"
        ),
    },
}

function createReservationModel() {
    const pipelines = []
    return {
        pipelines,
        async aggregate(pipeline) {
            pipelines.push(pipeline)
            const match = pipeline[0].$match

            if (match.$or?.[0]?.confirmedAt) {
                return [
                    {
                        current: [{ count: 3 }],
                        comparison: [{ count: 2 }],
                        trend: [
                            {
                                _id: "2026-07-28",
                                count: 1,
                            },
                            {
                                _id: "2026-07-30",
                                count: 2,
                            },
                        ],
                    },
                ]
            }
            if (match.$or?.[0]?.cancelledAt) {
                return [
                    {
                        current: [{ count: 2 }],
                        comparison: [],
                        trend: [
                            {
                                _id: "2026-07-29",
                                count: 2,
                            },
                        ],
                        reasons: [
                            {
                                _id: "Guest changed plans",
                                count: 1,
                            },
                            {
                                _id: "Travel disruption",
                                count: 1,
                            },
                        ],
                    },
                ]
            }
            if (match.checkedOutAt) {
                return [
                    {
                        total: [{ count: 3 }],
                        trend: [
                            {
                                _id: "2026-07-29",
                                count: 3,
                            },
                        ],
                        staff: [
                            {
                                _id: {
                                    staffId: "staff_2",
                                    name: "New Display Name",
                                },
                                count: 2,
                                totalDelayMinutes: 30,
                                delayCount: 2,
                            },
                            {
                                _id: {
                                    staffId: null,
                                    name: null,
                                },
                                count: 1,
                                totalDelayMinutes: -15,
                                delayCount: 1,
                            },
                        ],
                    },
                ]
            }
            if (match.checkedInAt) {
                return [
                    {
                        staff: [
                            {
                                _id: {
                                    staffId: "staff_1",
                                    name: "Persisted Agent",
                                },
                                count: 2,
                                totalDelayMinutes: -10,
                                delayCount: 2,
                            },
                            {
                                _id: {
                                    staffId: null,
                                    name: null,
                                },
                                count: 1,
                                totalDelayMinutes: 20,
                                delayCount: 1,
                            },
                        ],
                    },
                ]
            }
            if (match.createdAt) {
                return [
                    {
                        eligibleCount: 5,
                        cancelledCount: 2,
                    },
                ]
            }
            if (match.checkOutDate) {
                return [
                    {
                        scheduledCount: 4,
                        completedScheduledCount: 3,
                    },
                ]
            }
            throw new Error("Unexpected analytics pipeline")
        },
    }
}

test("lodging lifecycle analytics use persisted event timestamps and tenant-local buckets", async () => {
    const reservationModel = createReservationModel()

    const result = await getLodgingLifecycleAnalytics({
        businessId: "hotel_1",
        analyticsRange,
        hotelSettings: {
            checkInTime: "16:00",
            checkOutTime: "10:30",
        },
        reservationModel,
    })

    assert.deepEqual(result.lifecycle, {
        confirmations: {
            count: 3,
            comparisonPercent: 50,
        },
        cancellations: {
            count: 2,
            cancelledBookingCohortRatePercent: 40,
            comparisonPercent: null,
        },
        checkouts: {
            actualCount: 3,
            scheduledCount: 4,
            completedScheduledCount: 3,
            completionRatePercent: 75,
        },
    })
    assert.deepEqual(result.confirmationTrend, [
        { date: "2026-07-28", count: 1 },
        { date: "2026-07-29", count: 0 },
        { date: "2026-07-30", count: 2 },
    ])
    assert.deepEqual(result.cancellationTrend, [
        { date: "2026-07-28", count: 0 },
        { date: "2026-07-29", count: 2 },
        { date: "2026-07-30", count: 0 },
    ])
    assert.deepEqual(
        result.cancellationReasonBreakdown,
        [
            {
                reason: "Guest changed plans",
                count: 1,
                percentagePercent: 50,
            },
            {
                reason: "Travel disruption",
                count: 1,
                percentagePercent: 50,
            },
        ]
    )
    assert.deepEqual(result.checkoutTrend, [
        { date: "2026-07-28", count: 0 },
        { date: "2026-07-29", count: 3 },
        { date: "2026-07-30", count: 0 },
    ])

    assert.deepEqual(result.checkInStaffPerformance, [
        {
            staffId: "staff_1",
            name: "Persisted Agent",
            checkInsCompleted: 2,
            percentagePercent: 66.7,
            averageCheckInDelayMinutes: -5,
        },
    ])
    assert.deepEqual(result.checkOutStaffPerformance, [
        {
            staffId: "staff_2",
            name: "New Display Name",
            checkOutsCompleted: 2,
            percentagePercent: 66.7,
            averageCheckoutDelayMinutes: 15,
        },
    ])
    assert.deepEqual(result.staffAttribution, {
        unattributedCheckIns: 1,
        unattributedCheckOuts: 1,
    })

    for (const pipeline of reservationModel.pipelines) {
        assert.equal(
            pipeline[0].$match.businessId,
            "hotel_1"
        )
    }

    const confirmationPipeline =
        reservationModel.pipelines.find(
            (pipeline) =>
                pipeline[0].$match.$or?.[0]
                    ?.confirmedAt
        )
    const checkoutPipeline =
        reservationModel.pipelines.find(
            (pipeline) =>
                pipeline[0].$match.checkedOutAt
        )
    assert.ok(confirmationPipeline)
    assert.ok(checkoutPipeline)
    assert.equal(
        JSON.stringify(confirmationPipeline).includes(
            '"status":"confirmed"'
        ),
        false
    )
    assert.equal(
        JSON.stringify(checkoutPipeline).includes(
            '"status":"checked_out"'
        ),
        false
    )
    assert.match(
        JSON.stringify(checkoutPipeline),
        /Europe\/Berlin/
    )
    assert.match(
        JSON.stringify(checkoutPipeline),
        /10:30/
    )
})

test("empty lodging lifecycle data returns zero event facts and null unsupported rates", async () => {
    const reservationModel = {
        async aggregate() {
            return []
        },
    }

    const result = await getLodgingLifecycleAnalytics({
        businessId: "hotel_empty",
        analyticsRange,
        reservationModel,
    })

    assert.deepEqual(result.lifecycle, {
        confirmations: {
            count: 0,
            comparisonPercent: 0,
        },
        cancellations: {
            count: 0,
            cancelledBookingCohortRatePercent: null,
            comparisonPercent: 0,
        },
        checkouts: {
            actualCount: 0,
            scheduledCount: 0,
            completedScheduledCount: 0,
            completionRatePercent: null,
        },
    })
    assert.deepEqual(result.confirmationTrend, [])
    assert.deepEqual(result.cancellationTrend, [])
    assert.deepEqual(result.checkoutTrend, [])
    assert.deepEqual(result.checkInStaffPerformance, [])
    assert.deepEqual(result.checkOutStaffPerformance, [])
    assert.deepEqual(result.staffAttribution, {
        unattributedCheckIns: 0,
        unattributedCheckOuts: 0,
    })
})
