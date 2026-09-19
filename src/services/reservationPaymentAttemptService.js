import crypto from "node:crypto"
import mongoose from "mongoose"

import PendingCheckout from "../models/PendingCheckout.js"
import Reservation from "../models/Reservation.js"
import { confirmReservationPaymentAtomic } from "./reservationPaymentConfirmationService.js"

const ACTIVE_RESERVATION_ATTEMPT_FILTER = Object.freeze({
    checkoutType: "reservation",
    activeReservationAttempt: true,
})

export class ReservationPaymentAttemptError extends Error {
    constructor(message, { code, statusCode = 409 } = {}) {
        super(message)
        this.name = "ReservationPaymentAttemptError"
        this.code = code || "RESERVATION_PAYMENT_ATTEMPT_ERROR"
        this.statusCode = statusCode
    }
}

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

function normalizeCurrency(value) {
    return String(value || "").trim().toLowerCase()
}

function fingerprint(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function buildReservationPaymentAttemptFingerprint({
    reservationId,
    businessId,
    amountCents,
    currency,
    connectedAccountId,
    pricingSnapshotVersion,
}) {
    return fingerprint({
        reservationId: String(reservationId),
        businessId: String(businessId),
        amountCents: Number(amountCents),
        currency: normalizeCurrency(currency),
        connectedAccountId: String(connectedAccountId),
        pricingSnapshotVersion: Number(pricingSnapshotVersion),
    })
}

export function buildReservationStripeIdempotencyKey(reservationId, attemptId) {
    return `reservation-payment:${String(reservationId)}:${String(attemptId)}`
}

export function isIndeterminateReservationStripeError(error) {
    return error?.type === "StripeConnectionError" ||
        error?.type === "StripeAPIError" ||
        ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE"].includes(error?.code)
}

export function isDefinitiveReservationStripeCreationError(error) {
    return error?.type === "StripeInvalidRequestError" &&
        error?.type !== "StripeIdempotencyError"
}

function assertReusableAttempt(attempt, expected) {
    if (!attempt) return
    if (attempt.checkoutType !== "reservation") {
        throw new ReservationPaymentAttemptError(
            "The active payment attempt has an invalid type.",
            { code: "RESERVATION_ATTEMPT_TYPE_MISMATCH", statusCode: 500 },
        )
    }
    if (String(attempt.businessId) !== String(expected.businessId)) {
        throw new ReservationPaymentAttemptError(
            "The active payment attempt belongs to another business.",
            { code: "RESERVATION_ATTEMPT_TENANT_MISMATCH", statusCode: 409 },
        )
    }
    if (String(attempt.reservationId) !== String(expected.reservationId)) {
        throw new ReservationPaymentAttemptError(
            "The active payment attempt belongs to another reservation.",
            { code: "RESERVATION_ATTEMPT_RESERVATION_MISMATCH", statusCode: 409 },
        )
    }
    if (attempt.requestFingerprint !== expected.requestFingerprint) {
        throw new ReservationPaymentAttemptError(
            "Reservation economics changed while a payment attempt is active.",
            { code: "RESERVATION_ATTEMPT_FINGERPRINT_MISMATCH", statusCode: 409 },
        )
    }
}

async function createOrLoadActiveAttempt({
    reservation,
    business,
    amountCents,
    currency,
    stripeSessionConfigFactory,
    PendingCheckoutModel,
}) {
    const reservationId = reservation._id
    const businessId = reservation.businessId
    const requestFingerprint = buildReservationPaymentAttemptFingerprint({
        reservationId,
        businessId,
        amountCents,
        currency,
        connectedAccountId: business.stripeAccountId,
        pricingSnapshotVersion: reservation.pricingSnapshotVersion,
    })
    const expected = { reservationId, businessId, requestFingerprint }
    const existing = await PendingCheckoutModel.findOne({
        ...ACTIVE_RESERVATION_ATTEMPT_FILTER,
        reservationId,
    })
    if (existing) {
        assertReusableAttempt(existing, expected)
        return { attempt: existing, replayed: true }
    }

    const attemptId = new mongoose.Types.ObjectId()
    const stripeRequestIdempotencyKey = buildReservationStripeIdempotencyKey(
        reservationId,
        attemptId,
    )
    const stripeRequestSnapshot = stripeSessionConfigFactory(String(attemptId))
    const legacyStripeSessionId = reservation.stripeSessionId || null
    try {
        const attempt = await PendingCheckoutModel.create({
            _id: attemptId,
            checkoutType: "reservation",
            businessId,
            reservationId,
            activeReservationAttempt: true,
            legacyProviderSession: Boolean(legacyStripeSessionId),
            idempotencyKey: stripeRequestIdempotencyKey,
            requestFingerprint,
            status: "provider_pending",
            currency: normalizeCurrency(currency),
            grossAmount: amountCents,
            stripeConnectedAccountId: business.stripeAccountId,
            commissionAmountCents: Number(reservation.commissionAmountCents || 0),
            stripeSessionId: legacyStripeSessionId,
            stripeRequestIdempotencyKey,
            stripeRequestSnapshot,
            expiresAt: null,
        })
        return { attempt, replayed: false }
    } catch (error) {
        if (error?.code !== 11000) throw error
        const winner = await PendingCheckoutModel.findOne({
            ...ACTIVE_RESERVATION_ATTEMPT_FILTER,
            reservationId,
        })
        if (!winner) throw error
        assertReusableAttempt(winner, expected)
        return { attempt: winner, replayed: true }
    }
}

export function validateReservationProviderSession(session, attempt) {
    const expectedAmountCents = Number(attempt?.grossAmount)
    const observedAmountCents = Number(session?.amount_total)
    const expectedCurrency = normalizeCurrency(attempt?.currency)
    const observedCurrency = normalizeCurrency(session?.currency)
    const metadata = session?.metadata || {}

    if (session?.payment_status && !["paid", "unpaid", "no_payment_required"].includes(session.payment_status)) {
        return { valid: false, code: "PAYMENT_STATUS_INVALID" }
    }
    if (!Number.isSafeInteger(expectedAmountCents) || expectedAmountCents <= 0) {
        return { valid: false, code: "INVALID_EXPECTED_AMOUNT" }
    }
    if (!Number.isSafeInteger(observedAmountCents) || observedAmountCents !== expectedAmountCents) {
        return {
            valid: false,
            code: "PAYMENT_AMOUNT_MISMATCH",
            expectedAmountCents,
            observedAmountCents,
        }
    }
    if (!expectedCurrency || observedCurrency !== expectedCurrency) {
        return {
            valid: false,
            code: "PAYMENT_CURRENCY_MISMATCH",
            expectedCurrency,
            observedCurrency,
        }
    }
    if (
        metadata.reservationId &&
        String(metadata.reservationId) !== String(attempt.reservationId)
    ) {
        return { valid: false, code: "PAYMENT_RESERVATION_MISMATCH" }
    }
    if (metadata.businessId && metadata.businessId !== attempt.businessId) {
        return { valid: false, code: "PAYMENT_TENANT_MISMATCH" }
    }
    if (!attempt.legacyProviderSession) {
        if (String(metadata.pendingCheckoutId || "") !== String(attempt._id)) {
            return { valid: false, code: "PAYMENT_ATTEMPT_MISMATCH" }
        }
    }
    return {
        valid: true,
        expectedAmountCents,
        observedAmountCents,
        expectedCurrency,
        observedCurrency,
    }
}

export async function persistReservationStripeSession({
    attempt,
    reservation,
    stripeSession,
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    const validation = validateReservationProviderSession(stripeSession, attempt)
    if (!validation.valid) {
        throw new ReservationPaymentAttemptError(
            "Stripe returned a Session that does not match the payment attempt.",
            { code: validation.code, statusCode: 502 },
        )
    }
    if (attempt.stripeSessionId && attempt.stripeSessionId !== stripeSession.id) {
        throw new ReservationPaymentAttemptError(
            "The payment attempt is already linked to another Stripe Session.",
            { code: "STRIPE_SESSION_MISMATCH", statusCode: 409 },
        )
    }

    const stripeExpiresAt = Number.isFinite(Number(stripeSession.expires_at))
        ? new Date(Number(stripeSession.expires_at) * 1000)
        : attempt.stripeExpiresAt || null
    const providerStatus = stripeSession.status === "expired"
        ? "expired"
        : stripeSession.status === "complete"
            ? "completed"
            : "open"
    const linked = await PendingCheckoutModel.findOneAndUpdate(
        {
            _id: attempt._id,
            checkoutType: "reservation",
            businessId: reservation.businessId,
            reservationId: reservation._id,
            $or: [
                { stripeSessionId: null },
                { stripeSessionId: { $exists: false } },
                { stripeSessionId: stripeSession.id },
            ],
        },
        {
            $set: {
                stripeSessionId: stripeSession.id,
                stripeCheckoutUrl: stripeSession.url || attempt.stripeCheckoutUrl || null,
                stripeExpiresAt,
                stripePaymentIntentId: stripeSession.payment_intent || attempt.stripePaymentIntentId || null,
                status: providerStatus,
                activeReservationAttempt: providerStatus === "expired" ? null : true,
            },
        },
        { new: true },
    )
    if (!linked) {
        throw new ReservationPaymentAttemptError(
            "The payment attempt changed while Stripe Session identity was being persisted.",
            { code: "STRIPE_SESSION_LINK_RACE", statusCode: 409 },
        )
    }

    if (providerStatus !== "expired") {
        await ReservationModel.updateOne(
            {
                _id: reservation._id,
                businessId: reservation.businessId,
                status: "accepted_awaiting_payment",
                paymentStatus: { $ne: "paid" },
                $or: [
                    { stripeSessionId: null },
                    { stripeSessionId: { $exists: false } },
                    { stripeSessionId: stripeSession.id },
                ],
            },
            {
                $set: {
                    stripeSessionId: stripeSession.id,
                    stripeConnectedAccountId: attempt.stripeConnectedAccountId,
                },
            },
        )
    }
    return linked
}

export async function expireReservationPaymentAttempt({
    attempt,
    reservation,
    stripeSessionId,
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    const sessionId = stripeSessionId || attempt.stripeSessionId
    const result = await PendingCheckoutModel.updateOne(
        {
            _id: attempt._id,
            checkoutType: "reservation",
            businessId: reservation.businessId,
            reservationId: reservation._id,
            ...(sessionId ? { stripeSessionId: sessionId } : {}),
        },
        {
            $set: {
                status: "expired",
                activeReservationAttempt: null,
                ...(sessionId ? { stripeSessionId: sessionId } : {}),
            },
        },
    )
    if (result.matchedCount !== 1) {
        throw new ReservationPaymentAttemptError(
            "The expired reservation payment attempt could not be resolved.",
            { code: "RESERVATION_ATTEMPT_EXPIRY_RACE", statusCode: 409 },
        )
    }
    if (sessionId) {
        await ReservationModel.updateOne(
            {
                _id: reservation._id,
                businessId: reservation.businessId,
                status: "accepted_awaiting_payment",
                stripeSessionId: sessionId,
            },
            { $unset: { stripeSessionId: "" } },
        )
    }
    reservation.stripeSessionId = undefined
}

async function markDefinitiveCreationFailure({
    attempt,
    error,
    PendingCheckoutModel,
}) {
    await PendingCheckoutModel.updateOne(
        {
            _id: attempt._id,
            checkoutType: "reservation",
            activeReservationAttempt: true,
            status: "provider_pending",
        },
        {
            $set: {
                status: "creation_failed",
                activeReservationAttempt: null,
                stripeCreationFailureCode: error?.code || error?.type || "stripe_invalid_request",
            },
        },
    )
}

/**
 * Resolve one active Reservation attempt and one Stripe Session identity.
 * Concurrent callers may both reach Stripe, but they use the same persisted
 * request and stable idempotency key, so Stripe returns the same Session.
 */
export async function createOrReuseReservationCheckout({
    reservation,
    business,
    amountCents,
    currency,
    stripeSessionConfigFactory,
    stripeClient,
    now = new Date(),
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    if (!stripeClient?.checkout?.sessions?.create) {
        throw new ReservationPaymentAttemptError(
            "Stripe Checkout is not configured.",
            { code: "STRIPE_NOT_CONFIGURED", statusCode: 503 },
        )
    }

    for (let cycle = 0; cycle < 2; cycle += 1) {
        const { attempt, replayed } = await createOrLoadActiveAttempt({
            reservation,
            business,
            amountCents,
            currency,
            stripeSessionConfigFactory,
            PendingCheckoutModel,
        })

        let stripeSession = null
        const expiryMs = attempt.stripeExpiresAt
            ? new Date(attempt.stripeExpiresAt).getTime()
            : NaN
        const cachedOpenSession = attempt.status === "open" &&
            attempt.stripeSessionId &&
            attempt.stripeCheckoutUrl &&
            (!Number.isFinite(expiryMs) || expiryMs > now.getTime())
        if (cachedOpenSession) {
            return {
                sessionUrl: attempt.stripeCheckoutUrl,
                stripeSessionId: attempt.stripeSessionId,
                attemptId: String(attempt._id),
                replayed: true,
            }
        }

        try {
            if (attempt.stripeSessionId) {
                if (!stripeClient.checkout.sessions.retrieve) {
                    throw new ReservationPaymentAttemptError(
                        "Stripe Session recovery is not configured.",
                        { code: "STRIPE_RETRIEVE_NOT_CONFIGURED", statusCode: 503 },
                    )
                }
                stripeSession = await stripeClient.checkout.sessions.retrieve(
                    attempt.stripeSessionId,
                )
            } else {
                stripeSession = await stripeClient.checkout.sessions.create(
                    plain(attempt.stripeRequestSnapshot),
                    { idempotencyKey: attempt.stripeRequestIdempotencyKey },
                )
            }
        } catch (error) {
            if (error instanceof ReservationPaymentAttemptError) throw error
            if (isIndeterminateReservationStripeError(error)) {
                throw new ReservationPaymentAttemptError(
                    "Stripe did not return a definitive Checkout result. Retry is safe.",
                    { code: "STRIPE_CREATION_OUTCOME_UNKNOWN", statusCode: 503 },
                )
            }
            if (error?.type === "StripeIdempotencyError") {
                throw new ReservationPaymentAttemptError(
                    "Stripe rejected an incompatible replay for this payment attempt.",
                    { code: "STRIPE_IDEMPOTENCY_CONFLICT", statusCode: 409 },
                )
            }
            if (isDefinitiveReservationStripeCreationError(error)) {
                await markDefinitiveCreationFailure({
                    attempt,
                    error,
                    PendingCheckoutModel,
                })
            }
            throw error
        }

        const linked = await persistReservationStripeSession({
            attempt,
            reservation,
            stripeSession,
            PendingCheckoutModel,
            ReservationModel,
        })
        if (stripeSession.status === "expired") {
            await expireReservationPaymentAttempt({
                attempt: linked,
                reservation,
                stripeSessionId: stripeSession.id,
                PendingCheckoutModel,
                ReservationModel,
            })
            continue
        }

        const sessionUrl = stripeSession.url ||
            linked.stripeCheckoutUrl ||
            (stripeSession.status === "complete"
                ? attempt.stripeRequestSnapshot?.success_url
                : null)
        if (!sessionUrl) {
            throw new ReservationPaymentAttemptError(
                "Stripe Checkout did not return a usable Session URL.",
                { code: "STRIPE_SESSION_URL_MISSING", statusCode: 502 },
            )
        }
        return {
            sessionUrl,
            stripeSessionId: stripeSession.id,
            attemptId: String(attempt._id),
            replayed,
        }
    }

    throw new ReservationPaymentAttemptError(
        "The previous Stripe Session expired while a new payment attempt was being resolved.",
        { code: "RESERVATION_ATTEMPT_EXPIRY_RACE", statusCode: 409 },
    )
}

export async function recordUnexpectedReservationPayment({
    reservation,
    attempt = null,
    stripeSession,
    eventId,
    reason,
    now = new Date(),
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    const observedAmountCents = Number.isSafeInteger(Number(stripeSession?.amount_total))
        ? Number(stripeSession.amount_total)
        : 0
    const observedCurrency = normalizeCurrency(stripeSession?.currency)
    const expectedAmountCents = Number(attempt?.grossAmount ?? reservation.grossAmount ?? 0)
    const expectedCurrency = normalizeCurrency(attempt?.currency || reservation.currency)
    let reconciliationAttempt = attempt
    if (
        !reconciliationAttempt ||
        (
            reconciliationAttempt.stripeSessionId &&
            reconciliationAttempt.stripeSessionId !== stripeSession.id
        )
    ) {
        reconciliationAttempt = await PendingCheckoutModel.findOne({
            checkoutType: "reservation",
            stripeSessionId: stripeSession.id,
        })
    }

    let newlyRecorded = false
    const reconciliationFields = {
        status: "reconciliation_required",
        activeReservationAttempt: null,
        reconciliationStatus: "required",
        reconciliationReason: reason,
        reconciliationEventId: eventId || null,
        reconciliationObservedAt: now,
        reconciliationExpectedAmountCents: Number.isSafeInteger(expectedAmountCents)
            ? expectedAmountCents
            : null,
        reconciliationExpectedCurrency: expectedCurrency || null,
        reconciliationObservedAmountCents: observedAmountCents,
        reconciliationObservedCurrency: observedCurrency || null,
        stripePaymentIntentId: stripeSession?.payment_intent || null,
    }

    if (reconciliationAttempt) {
        if (
            String(reconciliationAttempt.businessId) !== String(reservation.businessId) ||
            String(reconciliationAttempt.reservationId) !== String(reservation._id)
        ) {
            throw new ReservationPaymentAttemptError(
                "Unexpected payment identity crosses a tenant or reservation boundary.",
                { code: "UNEXPECTED_PAYMENT_TENANT_MISMATCH", statusCode: 409 },
            )
        }
        const updated = await PendingCheckoutModel.updateOne(
            {
                _id: reconciliationAttempt._id,
                businessId: reservation.businessId,
                reservationId: reservation._id,
                reconciliationStatus: { $ne: "required" },
            },
            { $set: reconciliationFields },
        )
        newlyRecorded = updated.modifiedCount === 1
    } else {
        const shadowId = new mongoose.Types.ObjectId()
        try {
            reconciliationAttempt = await PendingCheckoutModel.create({
                _id: shadowId,
                checkoutType: "reservation",
                businessId: reservation.businessId,
                reservationId: reservation._id,
                activeReservationAttempt: null,
                legacyProviderSession: true,
                idempotencyKey: `reservation-reconciliation:${stripeSession.id}`,
                requestFingerprint: fingerprint({
                    reservationId: String(reservation._id),
                    businessId: reservation.businessId,
                    stripeSessionId: stripeSession.id,
                }),
                currency: observedCurrency || expectedCurrency,
                grossAmount: observedAmountCents || null,
                stripeSessionId: stripeSession.id,
                stripeConnectedAccountId: reservation.stripeConnectedAccountId || null,
                expiresAt: null,
                ...reconciliationFields,
            })
            newlyRecorded = true
        } catch (error) {
            if (error?.code !== 11000) throw error
            reconciliationAttempt = await PendingCheckoutModel.findOne({
                checkoutType: "reservation",
                stripeSessionId: stripeSession.id,
            })
            if (!reconciliationAttempt) {
                throw new ReservationPaymentAttemptError(
                    "The Stripe Session identity is already owned by another checkout domain.",
                    { code: "UNEXPECTED_PAYMENT_IDENTITY_CONFLICT", statusCode: 409 },
                )
            }
            if (
                (
                    String(reconciliationAttempt.businessId) !== String(reservation.businessId) ||
                    String(reconciliationAttempt.reservationId) !== String(reservation._id)
                )
            ) {
                throw new ReservationPaymentAttemptError(
                    "Unexpected payment identity crosses a tenant or reservation boundary.",
                    { code: "UNEXPECTED_PAYMENT_TENANT_MISMATCH", statusCode: 409 },
                )
            }
        }
    }

    if (newlyRecorded) {
        await ReservationModel.updateOne(
            { _id: reservation._id, businessId: reservation.businessId },
            {
                $set: {
                    paymentReconciliationStatus: "required",
                    lastUnexpectedPaymentAt: now,
                },
                $inc: {
                    unexpectedPaymentCount: 1,
                    unexpectedPaymentAmountCents: observedAmountCents,
                },
            },
        )
    }

    return { attempt: reconciliationAttempt, newlyRecorded }
}

async function adoptLegacyReservationAttempt({
    reservation,
    stripeSession,
    PendingCheckoutModel,
}) {
    const existing = await PendingCheckoutModel.findOne({
        checkoutType: "reservation",
        stripeSessionId: stripeSession.id,
    })
    if (existing) return existing

    const attemptId = new mongoose.Types.ObjectId()
    try {
        return await PendingCheckoutModel.create({
            _id: attemptId,
            checkoutType: "reservation",
            businessId: reservation.businessId,
            reservationId: reservation._id,
            activeReservationAttempt:
                reservation.status === "accepted_awaiting_payment" &&
                reservation.paymentStatus !== "paid"
                    ? true
                    : null,
            legacyProviderSession: true,
            idempotencyKey: `reservation-legacy:${stripeSession.id}`,
            requestFingerprint: fingerprint({
                reservationId: String(reservation._id),
                businessId: reservation.businessId,
                stripeSessionId: stripeSession.id,
            }),
            status: "open",
            currency: normalizeCurrency(reservation.currency),
            grossAmount: Number(reservation.grossAmount),
            stripeSessionId: stripeSession.id,
            stripeCheckoutUrl: stripeSession.url || null,
            stripeExpiresAt: Number.isFinite(Number(stripeSession.expires_at))
                ? new Date(Number(stripeSession.expires_at) * 1000)
                : null,
            stripePaymentIntentId: stripeSession.payment_intent || null,
            stripeConnectedAccountId: reservation.stripeConnectedAccountId || null,
            expiresAt: null,
        })
    } catch (error) {
        if (error?.code !== 11000) throw error
        const winner = await PendingCheckoutModel.findOne({
            checkoutType: "reservation",
            stripeSessionId: stripeSession.id,
        })
        if (winner) return winner
        throw error
    }
}

async function resolveReservationWebhookContext({
    stripeSession,
    PendingCheckoutModel,
    ReservationModel,
}) {
    const metadata = stripeSession?.metadata || {}
    let attempt = null
    let reservation = null

    if (metadata.pendingCheckoutId) {
        if (mongoose.isValidObjectId(metadata.pendingCheckoutId)) {
            attempt = await PendingCheckoutModel.findOne({
                _id: metadata.pendingCheckoutId,
                checkoutType: "reservation",
            })
        }
        if (attempt) {
            reservation = await ReservationModel.findOne({
                _id: attempt.reservationId,
                businessId: attempt.businessId,
            })
        }
    }

    if (!reservation && metadata.reservationId && mongoose.isValidObjectId(metadata.reservationId)) {
        reservation = await ReservationModel.findById(metadata.reservationId)
    }
    if (!reservation) return { attempt, reservation: null }

    if (!attempt) {
        const expectedLegacySession = reservation.stripeSessionId === stripeSession.id
        if (expectedLegacySession) {
            attempt = await adoptLegacyReservationAttempt({
                reservation,
                stripeSession,
                PendingCheckoutModel,
            })
        }
    }
    return { attempt, reservation }
}

async function completeAttempt({
    attempt,
    reservation,
    stripeSession,
    PendingCheckoutModel,
}) {
    const result = await PendingCheckoutModel.updateOne(
        {
            _id: attempt._id,
            checkoutType: "reservation",
            businessId: reservation.businessId,
            reservationId: reservation._id,
            stripeSessionId: stripeSession.id,
        },
        {
            $set: {
                status: "completed",
                activeReservationAttempt: null,
                stripePaymentIntentId: stripeSession.payment_intent || null,
            },
        },
    )
    if (result.matchedCount !== 1) {
        throw new ReservationPaymentAttemptError(
            "The canonical Reservation payment attempt could not be completed.",
            { code: "RESERVATION_ATTEMPT_COMPLETION_RACE", statusCode: 500 },
        )
    }
}

/**
 * Reconcile a signed checkout.session.completed event against persisted
 * Reservation attempt/session identity. The caller owns email dispatch only
 * when `transitioned` is true.
 */
export async function reconcileReservationCheckoutCompleted({
    stripeSession,
    eventId,
    now = new Date(),
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    const metadata = stripeSession?.metadata || {}
    const context = await resolveReservationWebhookContext({
        stripeSession,
        PendingCheckoutModel,
        ReservationModel,
    })
    const { reservation } = context
    let { attempt } = context
    if (!reservation) {
        if (attempt && stripeSession.payment_status === "paid") {
            await PendingCheckoutModel.updateOne(
                { _id: attempt._id, checkoutType: "reservation" },
                {
                    $set: {
                        status: "reconciliation_required",
                        activeReservationAttempt: null,
                        reconciliationStatus: "required",
                        reconciliationReason: "reservation_missing",
                        reconciliationEventId: eventId || null,
                        reconciliationObservedAt: now,
                        reconciliationExpectedAmountCents:
                            Number(attempt.grossAmount) || null,
                        reconciliationExpectedCurrency:
                            normalizeCurrency(attempt.currency) || null,
                        reconciliationObservedAmountCents:
                            Number(stripeSession.amount_total) || 0,
                        reconciliationObservedCurrency:
                            normalizeCurrency(stripeSession.currency) || null,
                        stripePaymentIntentId:
                            stripeSession.payment_intent || null,
                    },
                },
            )
        }
        return {
            accepted: false,
            httpStatus: 404,
            code: "RESERVATION_NOT_FOUND",
        }
    }

    // Resolve tenant and Reservation from the persisted attempt whenever one
    // exists; provider metadata remains correlation data only.
    const metadataMismatch =
        (metadata.reservationId && String(metadata.reservationId) !== String(reservation._id)) ||
        (metadata.businessId && metadata.businessId !== reservation.businessId) ||
        (attempt && metadata.pendingCheckoutId && String(metadata.pendingCheckoutId) !== String(attempt._id))
    if (metadataMismatch) {
        if (stripeSession.payment_status === "paid") {
            await recordUnexpectedReservationPayment({
                reservation,
                attempt,
                stripeSession,
                eventId,
                reason: "provider_metadata_mismatch",
                now,
                PendingCheckoutModel,
                ReservationModel,
            })
        }
        return { accepted: false, httpStatus: 400, code: "PAYMENT_METADATA_MISMATCH" }
    }

    if (stripeSession.payment_status !== "paid") {
        return { accepted: false, ignored: true, httpStatus: 200, code: "PAYMENT_NOT_PAID" }
    }

    if (!attempt) {
        await recordUnexpectedReservationPayment({
            reservation,
            stripeSession,
            eventId,
            reason: "payment_attempt_missing",
            now,
            PendingCheckoutModel,
            ReservationModel,
        })
        return { accepted: false, httpStatus: 409, code: "PAYMENT_ATTEMPT_MISSING" }
    }

    // A webhook can beat the API response. Persist the identity from the
    // exact durable attempt metadata before deciding whether it is canonical.
    if (!attempt.stripeSessionId) {
        try {
            attempt = await persistReservationStripeSession({
                attempt,
                reservation,
                stripeSession,
                PendingCheckoutModel,
                ReservationModel,
            })
        } catch (error) {
            await recordUnexpectedReservationPayment({
                reservation,
                attempt,
                stripeSession,
                eventId,
                reason: error?.code || "provider_session_link_failed",
                now,
                PendingCheckoutModel,
                ReservationModel,
            })
            return { accepted: false, httpStatus: 409, code: error?.code || "PAYMENT_SESSION_MISMATCH" }
        }
    }

    if (
        reservation.paymentStatus === "paid" &&
        reservation.stripeCheckoutSessionId !== stripeSession.id
    ) {
        await recordUnexpectedReservationPayment({
            reservation,
            attempt,
            stripeSession,
            eventId,
            reason: "duplicate_successful_payment",
            now,
            PendingCheckoutModel,
            ReservationModel,
        })
        return { accepted: false, httpStatus: 200, code: "DUPLICATE_PAYMENT_RECORDED" }
    }

    if (attempt.stripeSessionId !== stripeSession.id) {
        await recordUnexpectedReservationPayment({
            reservation,
            attempt,
            stripeSession,
            eventId,
            reason: "unexpected_provider_session",
            now,
            PendingCheckoutModel,
            ReservationModel,
        })
        return { accepted: false, httpStatus: 409, code: "UNEXPECTED_STRIPE_SESSION" }
    }

    const validation = validateReservationProviderSession(stripeSession, attempt)
    if (!validation.valid) {
        await recordUnexpectedReservationPayment({
            reservation,
            attempt,
            stripeSession,
            eventId,
            reason: validation.code,
            now,
            PendingCheckoutModel,
            ReservationModel,
        })
        return { accepted: false, httpStatus: 400, code: validation.code }
    }

    if (reservation.paymentStatus === "paid") {
        if (reservation.stripeCheckoutSessionId === stripeSession.id) {
            await completeAttempt({
                attempt,
                reservation,
                stripeSession,
                PendingCheckoutModel,
            })
            return {
                accepted: true,
                transitioned: false,
                alreadyPaid: true,
                reservation,
                attempt,
                httpStatus: 200,
            }
        }
        // The different-Session case is classified above. Reaching this branch
        // means the canonical Session was delivered again.
        return { accepted: true, transitioned: false, alreadyPaid: true, reservation, attempt, httpStatus: 200 }
    }

    if (
        attempt.activeReservationAttempt !== true ||
        !["provider_pending", "open", "completed"].includes(attempt.status)
    ) {
        await recordUnexpectedReservationPayment({
            reservation,
            attempt,
            stripeSession,
            eventId,
            reason: "inactive_payment_attempt_succeeded",
            now,
            PendingCheckoutModel,
            ReservationModel,
        })
        return { accepted: false, httpStatus: 409, code: "INACTIVE_PAYMENT_ATTEMPT" }
    }

    const transition = await confirmReservationPaymentAtomic({
        reservationId: reservation._id,
        businessId: reservation.businessId,
        expectedAmountCents: validation.expectedAmountCents,
        expectedCurrency: validation.expectedCurrency,
        checkoutSessionId: stripeSession.id,
        paymentIntentId: stripeSession.payment_intent || null,
        confirmedAt: now,
        reservationModel: ReservationModel,
    })
    if (transition.transitioned) {
        await completeAttempt({
            attempt,
            reservation: transition.reservation,
            stripeSession,
            PendingCheckoutModel,
        })
        return {
            accepted: true,
            transitioned: true,
            reservation: transition.reservation,
            attempt,
            httpStatus: 200,
        }
    }
    if (
        transition.alreadyPaid &&
        transition.reservation?.stripeCheckoutSessionId === stripeSession.id
    ) {
        await completeAttempt({
            attempt,
            reservation: transition.reservation,
            stripeSession,
            PendingCheckoutModel,
        })
        return {
            accepted: true,
            transitioned: false,
            alreadyPaid: true,
            reservation: transition.reservation,
            attempt,
            httpStatus: 200,
        }
    }

    await recordUnexpectedReservationPayment({
        reservation: transition.reservation || reservation,
        attempt,
        stripeSession,
        eventId,
        reason: transition.alreadyPaid
            ? "duplicate_successful_payment"
            : "reservation_state_mismatch",
        now,
        PendingCheckoutModel,
        ReservationModel,
    })
    return {
        accepted: false,
        httpStatus: transition.alreadyPaid ? 200 : 409,
        code: transition.alreadyPaid
            ? "DUPLICATE_PAYMENT_RECORDED"
            : "RESERVATION_PAYMENT_STATE_CHANGED",
    }
}

export async function reconcileReservationCheckoutExpired({
    stripeSession,
    PendingCheckoutModel = PendingCheckout,
    ReservationModel = Reservation,
}) {
    const { attempt, reservation } = await resolveReservationWebhookContext({
        stripeSession,
        PendingCheckoutModel,
        ReservationModel,
    })
    if (!attempt || !reservation) {
        return { handled: false, code: "RESERVATION_ATTEMPT_NOT_FOUND" }
    }
    const metadata = stripeSession.metadata || {}
    if (
        (metadata.reservationId && String(metadata.reservationId) !== String(reservation._id)) ||
        (metadata.businessId && metadata.businessId !== reservation.businessId) ||
        (attempt.stripeSessionId && attempt.stripeSessionId !== stripeSession.id)
    ) {
        return { handled: false, code: "RESERVATION_ATTEMPT_MISMATCH" }
    }
    if (!attempt.stripeSessionId) {
        const linked = await PendingCheckoutModel.findOneAndUpdate(
            {
                _id: attempt._id,
                businessId: reservation.businessId,
                reservationId: reservation._id,
                stripeSessionId: null,
            },
            { $set: { stripeSessionId: stripeSession.id } },
            { new: true },
        )
        if (!linked) return { handled: false, code: "RESERVATION_ATTEMPT_LINK_RACE" }
        attempt.stripeSessionId = stripeSession.id
    }
    await expireReservationPaymentAttempt({
        attempt,
        reservation,
        stripeSessionId: stripeSession.id,
        PendingCheckoutModel,
        ReservationModel,
    })
    return { handled: true, attemptId: String(attempt._id) }
}
