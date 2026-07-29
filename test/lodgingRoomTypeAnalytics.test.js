import assert from "node:assert/strict"
import test from "node:test"
import { getLodgingRoomTypeAnalytics } from "../src/services/analytics/lodging/lodgingRoomTypeAnalytics.js"

const analyticsRange = {
    preset: "7days",
    timezone: "Europe/Berlin",
    from: "2026-07-01",
    to: "2026-07-07",
    startUtc: new Date("2026-06-30T22:00:00.000Z"),
    endUtcExclusive: new Date(
        "2026-07-07T22:00:00.000Z"
    ),
    comparison: {
        from: "2026-06-24",
        to: "2026-06-30",
        startUtc: new Date(
            "2026-06-23T22:00:00.000Z"
        ),
        endUtcExclusive: new Date(
            "2026-06-30T22:00:00.000Z"
        ),
    },
}

test("room-type performance uses snapshots, current room inventory, unique room nights, and integer cents", async () => {
    const pipelines = []
    const reservationModel = {
        async aggregate(pipeline) {
            pipelines.push(pipeline)
            if (
                pipeline[0].$match.paymentStatus ===
                "paid"
            ) {
                return [
                    {
                        _id: {
                            servicePointId: "room_101",
                            roomTypeSnapshot:
                                "Deluxe Suite",
                        },
                        paidBookingCount: 2,
                        paidRevenueCents: 40000,
                    },
                    {
                        _id: {
                            servicePointId: "room_102",
                            roomTypeSnapshot:
                                "DELUXE SUITE",
                        },
                        paidBookingCount: 1,
                        paidRevenueCents: 10000,
                    },
                    {
                        _id: {
                            servicePointId:
                                "removed_room",
                            roomTypeSnapshot: null,
                        },
                        paidBookingCount: 1,
                        paidRevenueCents: 5000,
                    },
                ]
            }
            return [
                {
                    servicePointId: "room_101",
                    roomTypeSnapshot: "Deluxe Suite",
                    checkInDate: "2026-07-01",
                    checkOutDate: "2026-07-04",
                },
                // Duplicate input cannot inflate occupied room-nights.
                {
                    servicePointId: "room_101",
                    roomTypeSnapshot: "Deluxe Suite",
                    checkInDate: "2026-07-01",
                    checkOutDate: "2026-07-04",
                },
                {
                    servicePointId: "room_102",
                    roomTypeSnapshot: "deluxe suite",
                    checkInDate: "2026-07-03",
                    checkOutDate: "2026-07-05",
                },
            ]
        },
    }
    let servicePointQuery
    const servicePointModel = {
        find(filter, projection) {
            servicePointQuery = {
                filter,
                projection,
            }
            return {
                lean: async () => [
                    {
                        servicePointId: "room_101",
                        servicePointType: "room",
                        roomType: "Deluxe Suite",
                        isActive: true,
                        reservable: true,
                    },
                    {
                        servicePointId: "room_102",
                        servicePointType: "room",
                        roomType: " deluxe suite ",
                        isActive: true,
                        reservable: true,
                    },
                    {
                        servicePointId: "room_103",
                        servicePointType: "room",
                        roomType: "Standard",
                        isActive: false,
                        reservable: true,
                    },
                ],
            }
        },
    }

    const result = await getLodgingRoomTypeAnalytics({
        businessId: "hotel_1",
        analyticsRange,
        reservationModel,
        servicePointModel,
    })

    assert.deepEqual(result, [
        {
            roomType: "Deluxe Suite",
            roomCount: 2,
            paidBookingCount: 3,
            bookedNights: 5,
            paidRevenueCents: 50000,
            averageBookingValueCents: 16667,
            occupancyRatePercent: 35.7,
        },
        {
            roomType: "Uncategorized",
            roomCount: 0,
            paidBookingCount: 1,
            bookedNights: 0,
            paidRevenueCents: 5000,
            averageBookingValueCents: 5000,
            occupancyRatePercent: null,
        },
    ])
    assert.deepEqual(servicePointQuery.filter, {
        businessId: "hotel_1",
        servicePointType: "room",
    })
    assert.match(servicePointQuery.projection, /roomType/)
    assert.equal(pipelines.length, 2)
    for (const pipeline of pipelines) {
        assert.equal(
            pipeline[0].$match.businessId,
            "hotel_1"
        )
    }
    assert.equal(
        pipelines[1][0].$match.status.$in.includes(
            "cancelled"
        ),
        false
    )
})

test("room-type performance returns no fabricated rows for an empty hotel", async () => {
    const result = await getLodgingRoomTypeAnalytics({
        businessId: "hotel_empty",
        analyticsRange,
        reservationModel: {
            async aggregate() {
                return []
            },
        },
        servicePointModel: {
            find() {
                return { lean: async () => [] }
            },
        },
    })

    assert.deepEqual(result, [])
})
