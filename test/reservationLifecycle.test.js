import assert from "node:assert/strict"
import test from "node:test"
import Business from "../src/models/Business.js"
import Reservation from "../src/models/Reservation.js"
import {
    deleteReservation,
    isReservationStatusTransitionAllowed,
    toOwnerReservationResponse,
    updateReservationStatus,
} from "../src/controllers/reservationController.js"
import { applyReservationPaymentConfirmation } from "../src/services/reservationPaymentConfirmationService.js"

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
}

function sessionUser(overrides = {}) {
    return {
        businessId: "hotel_1",
        userId: "staff_1",
        name: "Reception Agent",
        email: "agent@example.com",
        role: "owner",
        ...overrides,
    }
}

function stayReservation(overrides = {}) {
    const reservation = {
        _id: "reservation_1",
        businessId: "hotel_1",
        status: "pending",
        checkInDate: "2026-08-01",
        checkOutDate: "2026-08-03",
        confirmedAt: null,
        cancelledAt: null,
        checkedOutAt: null,
        archivedAt: null,
        email: null,
        ...overrides,
    }
    reservation.toObject = () => ({ ...reservation })
    return reservation
}

function mockHotelBusiness(t) {
    t.mock.method(Business, "findOne", () => ({
        lean: async () => ({
            businessId: "hotel_1",
            businessType: "hotel",
            modules: ["lodging"],
            ownerEmail: "agent@example.com",
        }),
    }))
}

test("hotel stays require the explicit checked_out transition instead of completed status", () => {
    assert.equal(
        isReservationStatusTransitionAllowed({
            currentStatus: "checked_in",
            nextStatus: "checked_out",
            isStay: true,
        }),
        true
    )
    assert.equal(
        isReservationStatusTransitionAllowed({
            currentStatus: "checked_in",
            nextStatus: "completed",
            isStay: true,
        }),
        false
    )
})

test("owner reservation response exposes refund summaries without leaking the internal lock", () => {
    const responseRecord = toOwnerReservationResponse(
        stayReservation({
            paymentStatus: "partially_refunded",
            amountPaidCents: 30000,
            refundedAmountCents: 12000,
            activeRefundId: "RF-INTERNAL-LOCK",
        }),
    )

    assert.equal(responseRecord.originalPaidAmountCents, 30000)
    assert.equal(responseRecord.refundedAmountCents, 12000)
    assert.equal(responseRecord.remainingRefundableAmountCents, 18000)
    assert.equal(responseRecord.refundPending, true)
    assert.equal("activeRefundId" in responseRecord, false)
})

test("staff confirmation atomically writes confirmedAt and actor attribution", async (t) => {
    mockHotelBusiness(t)
    const reservation = stayReservation()
    let captured
    t.mock.method(
        Reservation,
        "findOne",
        async (filter) => {
            assert.deepEqual(filter, {
                _id: reservation._id,
                businessId: "hotel_1",
            })
            return reservation
        }
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async (filter, update) => {
            captured = { filter, update }
            return stayReservation({
                ...reservation,
                ...update.$set,
            })
        }
    )
    const res = response()

    await updateReservationStatus(
        {
            params: { id: reservation._id },
            body: { status: "confirmed" },
            session: { user: sessionUser() },
        },
        res
    )

    assert.equal(res.statusCode, 200)
    assert.equal(captured.filter.status, "pending")
    assert.ok(captured.update.$set.confirmedAt instanceof Date)
    assert.deepEqual(captured.update.$set.confirmedBy, {
        userId: "staff_1",
        name: "Reception Agent",
        email: "agent@example.com",
        role: "owner",
    })
})

test("idempotent confirmation preserves the original event timestamp", async (t) => {
    mockHotelBusiness(t)
    const originalConfirmedAt = new Date(
        "2026-07-29T08:00:00.000Z"
    )
    const reservation = stayReservation({
        status: "confirmed",
        confirmedAt: originalConfirmedAt,
    })
    t.mock.method(
        Reservation,
        "findOne",
        async () => reservation
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async () => {
            throw new Error("idempotent retry must not write")
        }
    )
    const res = response()

    await updateReservationStatus(
        {
            params: { id: reservation._id },
            body: { status: "confirmed" },
            session: { user: sessionUser() },
        },
        res
    )

    assert.equal(res.statusCode, 200)
    assert.equal(
        res.body.reservation.confirmedAt,
        originalConfirmedAt
    )
})

test("payment confirmation writes confirmedAt once without inventing an actor", () => {
    const originalConfirmedAt = new Date(
        "2026-07-29T07:00:00.000Z"
    )
    const originalPaidAt = new Date(
        "2026-07-29T06:59:00.000Z"
    )
    const retry = {
        confirmedAt: originalConfirmedAt,
        paidAt: originalPaidAt,
    }
    applyReservationPaymentConfirmation(retry, {
        checkoutSessionId: "cs_1",
        paymentIntentId: "pi_1",
        amountPaidCents: 25000,
        confirmedAt: new Date(
            "2026-07-29T09:00:00.000Z"
        ),
    })

    assert.equal(retry.confirmedAt, originalConfirmedAt)
    assert.equal(retry.paidAt, originalPaidAt)
    assert.equal(retry.paymentStatus, "paid")
    assert.equal(retry.status, "confirmed")
    assert.equal(retry.amountPaidCents, 25000)
    assert.equal("confirmedBy" in retry, false)
})

test("cancellation retains the record and persists its first reason and actor", async (t) => {
    mockHotelBusiness(t)
    const reservation = stayReservation({
        status: "confirmed",
        confirmedAt: new Date(),
    })
    let update
    t.mock.method(
        Reservation,
        "findOne",
        async () => reservation
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async (_filter, operation) => {
            update = operation.$set
            return stayReservation({
                ...reservation,
                ...operation.$set,
            })
        }
    )
    const res = response()

    await updateReservationStatus(
        {
            params: { id: reservation._id },
            body: {
                status: "cancelled",
                cancellationReason:
                    "  Guest   changed plans  ",
            },
            session: { user: sessionUser() },
        },
        res
    )

    assert.equal(res.statusCode, 200)
    assert.ok(update.cancelledAt instanceof Date)
    assert.equal(
        update.cancellationReason,
        "Guest changed plans"
    )
    assert.equal(update.cancelledBy.actorType, "staff")
    assert.equal(update.cancelledBy.userId, "staff_1")
    assert.equal(res.body.reservation.status, "cancelled")
})

test("the generic status endpoint cannot bypass paid cancellation payment handling", async (t) => {
    mockHotelBusiness(t)
    const reservation = stayReservation({
        status: "confirmed",
        paymentStatus: "paid",
        confirmedAt: new Date(),
    })
    t.mock.method(Reservation, "findOne", async () => reservation)
    t.mock.method(Reservation, "findOneAndUpdate", async () => {
        throw new Error("paid cancellation must use the explicit operation")
    })
    const res = response()

    await updateReservationStatus(
        {
            params: { id: reservation._id },
            body: { status: "cancelled" },
            session: { user: sessionUser() },
        },
        res,
    )

    assert.equal(res.statusCode, 409)
    assert.match(res.body.error, /explicit cancellation workflow/i)
})

test("checkout requires checked_in and preserves the first timestamp on retry", async (t) => {
    mockHotelBusiness(t)
    const checkedIn = stayReservation({
        status: "checked_in",
    })
    let currentReservation = checkedIn
    let updateCount = 0
    let firstUpdate
    t.mock.method(
        Reservation,
        "findOne",
        async () => currentReservation
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async (_filter, update) => {
            updateCount += 1
            firstUpdate = update.$set
            return stayReservation({
                ...checkedIn,
                ...update.$set,
            })
        }
    )
    const firstResponse = response()

    await updateReservationStatus(
        {
            params: { id: checkedIn._id },
            body: { status: "checked_out" },
            session: { user: sessionUser() },
        },
        firstResponse
    )

    assert.equal(firstResponse.statusCode, 200)
    assert.ok(firstUpdate.checkedOutAt instanceof Date)
    assert.equal(
        firstUpdate.checkedOutBy.userId,
        "staff_1"
    )

    const checkedOut = stayReservation({
        status: "checked_out",
        checkedOutAt: firstUpdate.checkedOutAt,
        checkedOutBy: firstUpdate.checkedOutBy,
    })
    currentReservation = checkedOut
    const retryResponse = response()
    await updateReservationStatus(
        {
            params: { id: checkedOut._id },
            body: { status: "checked_out" },
            session: { user: sessionUser() },
        },
        retryResponse
    )

    assert.equal(retryResponse.statusCode, 200)
    assert.equal(updateCount, 1)
    assert.equal(
        retryResponse.body.reservation.checkedOutAt,
        firstUpdate.checkedOutAt
    )
})

test("invalid checkout and cross-tenant lifecycle actions are rejected", async (t) => {
    mockHotelBusiness(t)
    const confirmed = stayReservation({
        status: "confirmed",
    })
    let requestedScope
    t.mock.method(
        Reservation,
        "findOne",
        async (filter) => {
            requestedScope = filter
            return filter.businessId === "hotel_1"
                ? confirmed
                : null
        }
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async () => {
            throw new Error("invalid action must not write")
        }
    )

    const invalidResponse = response()
    await updateReservationStatus(
        {
            params: { id: confirmed._id },
            body: { status: "checked_out" },
            session: { user: sessionUser() },
        },
        invalidResponse
    )
    assert.equal(invalidResponse.statusCode, 409)

    const tenantResponse = response()
    await updateReservationStatus(
        {
            params: { id: confirmed._id },
            body: { status: "cancelled" },
            session: {
                user: sessionUser({
                    businessId: "other_hotel",
                }),
            },
        },
        tenantResponse
    )
    assert.equal(tenantResponse.statusCode, 404)
    assert.equal(
        requestedScope.businessId,
        "other_hotel"
    )
})

test("owner removal archives a terminal reservation instead of deleting it", async (t) => {
    const reservation = stayReservation({
        status: "cancelled",
        cancelledAt: new Date(),
    })
    let update
    t.mock.method(
        Reservation,
        "findOne",
        async () => reservation
    )
    t.mock.method(
        Reservation,
        "findOneAndUpdate",
        async (_filter, operation) => {
            update = operation.$set
            return {
                ...reservation,
                ...operation.$set,
            }
        }
    )
    t.mock.method(
        Reservation,
        "findByIdAndDelete",
        async () => {
            throw new Error("historical record must not be deleted")
        }
    )
    const res = response()

    await deleteReservation(
        {
            params: { id: reservation._id },
            session: { user: sessionUser() },
        },
        res
    )

    assert.equal(res.statusCode, 200)
    assert.ok(update.archivedAt instanceof Date)
    assert.equal(update.archivedBy.userId, "staff_1")
    assert.match(res.body.message, /operational views/i)
})
