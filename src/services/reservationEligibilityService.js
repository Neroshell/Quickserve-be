import Business from "../models/Business.js"

export const RESERVATION_ELIGIBLE_BUSINESS_STATUS = "active"

export const RESERVATION_ELIGIBILITY_MESSAGES = Object.freeze({
    onboardingIncomplete: "This business is not yet accepting reservations.",
    unavailable: "This business is not currently accepting reservations.",
})

export class ReservationEligibilityError extends Error {
    constructor(message, { code, statusCode = 403 } = {}) {
        super(message)
        this.name = "ReservationEligibilityError"
        this.code = code || "BUSINESS_RESERVATIONS_UNAVAILABLE"
        this.statusCode = statusCode
    }
}

export function getReservationEligibility(business) {
    if (business?.status !== RESERVATION_ELIGIBLE_BUSINESS_STATUS) {
        return {
            eligible: false,
            code: "BUSINESS_RESERVATIONS_UNAVAILABLE",
            message: RESERVATION_ELIGIBILITY_MESSAGES.unavailable,
        }
    }
    if (business?.onboardingCompleted !== true) {
        return {
            eligible: false,
            code: "BUSINESS_ONBOARDING_INCOMPLETE",
            message: RESERVATION_ELIGIBILITY_MESSAGES.onboardingIncomplete,
        }
    }
    return { eligible: true, code: null, message: null }
}

export function assertReservationEligibility(business) {
    const eligibility = getReservationEligibility(business)
    if (!eligibility.eligible) {
        throw new ReservationEligibilityError(eligibility.message, eligibility)
    }
    return business
}

export function reservationEligibilityFilter(extra = {}) {
    return {
        ...extra,
        status: RESERVATION_ELIGIBLE_BUSINESS_STATUS,
        onboardingCompleted: true,
    }
}

export function hasReservationEligibilityMutation(update = {}) {
    return Object.hasOwn(update, "status") || Object.hasOwn(update, "onboardingCompleted")
}

export function withReservationEligibilityFence(update = {}, now = new Date()) {
    return {
        ...update,
        $set: {
            ...(update.$set || {}),
            reservationEligibilityChangedAt: now,
        },
        $inc: {
            ...(update.$inc || {}),
            reservationEligibilityVersion: 1,
        },
    }
}

/**
 * Acquire a document-level eligibility fence in an existing transaction.
 *
 * This is deliberately a write, not merely a transactional read. It serializes
 * reservation creation with status/onboarding transitions that update the same
 * Business document. A transition committed first makes the predicate fail;
 * a reservation committed first is ordered before that transition.
 */
export async function acquireReservationEligibilityFence({
    businessId,
    session,
    businessModel = Business,
    now = new Date(),
} = {}) {
    if (!businessId) {
        throw new ReservationEligibilityError(
            RESERVATION_ELIGIBILITY_MESSAGES.unavailable,
            { code: "BUSINESS_RESERVATIONS_UNAVAILABLE", statusCode: 404 },
        )
    }

    const query = businessModel.findOneAndUpdate(
        reservationEligibilityFilter({ businessId }),
        {
            $inc: { reservationEligibilityVersion: 1 },
            $set: { reservationEligibilityCheckedAt: now },
        },
        { new: true, ...(session ? { session } : {}) },
    )
    const business = typeof query?.lean === "function" ? await query.lean() : await query
    if (!business) {
        throw new ReservationEligibilityError(
            RESERVATION_ELIGIBILITY_MESSAGES.unavailable,
            { code: "BUSINESS_RESERVATIONS_UNAVAILABLE", statusCode: 403 },
        )
    }
    return business
}
