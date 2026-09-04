import Stripe from "stripe"

import { getPendingCheckoutExpiresAt } from "../constants/checkoutRetention.js"
import {
    INVENTORY_PROVIDER_CREATION_REPAIR_DELAY_MS,
    INVENTORY_REPAIR_SCAN_LIMIT,
    INVENTORY_RESERVATION_PROVIDER_STATES,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_STATUSES,
} from "../constants/inventoryReservation.js"
import InventoryReservation from "../models/InventoryReservation.js"
import PendingCheckout from "../models/PendingCheckout.js"
import { withCanonicalInventoryTransaction } from "./canonicalInventoryService.js"
import { invalidateMenuItems } from "./cacheInvalidationService.js"
import {
    attachStripeSessionToInventoryReservation,
    releaseInventoryReservation,
    releaseInventoryReservationWithinTransaction,
} from "./inventoryReservationService.js"

const defaultStripeClient = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

function providerStateFor(session) {
    if (session?.status === "expired") return INVENTORY_RESERVATION_PROVIDER_STATES.EXPIRED
    if (session?.status === "complete") return INVENTORY_RESERVATION_PROVIDER_STATES.COMPLETE
    if (session?.status === "open") return INVENTORY_RESERVATION_PROVIDER_STATES.OPEN
    return INVENTORY_RESERVATION_PROVIDER_STATES.UNKNOWN
}

export async function persistStripeCheckoutLink({
    businessId,
    pendingCheckoutId,
    inventoryReservationId = null,
    stripeSession,
}, {
    PendingCheckoutModel = PendingCheckout,
    InventoryReservationModel = InventoryReservation,
} = {}) {
    return withCanonicalInventoryTransaction(async (session) => {
        const pending = await PendingCheckoutModel.findOne({
            _id: pendingCheckoutId,
            businessId,
        }, null, { session })
        if (!pending) throw new Error("PendingCheckout was not found during Stripe linkage")
        if (pending.stripeSessionId && pending.stripeSessionId !== stripeSession.id) {
            const error = new Error("PendingCheckout is already linked to another Stripe session")
            error.code = "STRIPE_SESSION_MISMATCH"
            throw error
        }

        if (inventoryReservationId) {
            await attachStripeSessionToInventoryReservation({
                businessId,
                reservationId: inventoryReservationId,
                pendingCheckoutId,
                stripeSession,
                session,
            }, { InventoryReservationModel })
        }

        pending.stripeSessionId = stripeSession.id
        pending.stripeCheckoutUrl = stripeSession.url || pending.stripeCheckoutUrl || null
        pending.stripeExpiresAt = Number.isFinite(Number(stripeSession.expires_at))
            ? new Date(Number(stripeSession.expires_at) * 1000)
            : pending.stripeExpiresAt
        pending.expiresAt = getPendingCheckoutExpiresAt({
            stripeExpiresAt: stripeSession.expires_at,
        })
        pending.stripePaymentIntentId = stripeSession.payment_intent ||
            pending.stripePaymentIntentId || null
        pending.status = stripeSession.status === "expired"
            ? "expired"
            : stripeSession.status === "complete"
                ? "completed"
                : "open"
        await pending.save({ session })
        return { pending, providerState: providerStateFor(stripeSession) }
    })
}

function isDefinitiveStripeCreationFailure(error) {
    return error?.type === "StripeInvalidRequestError" ||
        error?.code === "parameter_invalid_integer" ||
        error?.code === "parameter_invalid_empty"
}

/** Atomically marks provider creation failed and releases its exact hold. */
export async function compensateStripeCheckoutCreationFailure({
    businessId,
    pendingCheckoutId,
    inventoryReservationId,
    failureCode,
}, {
    PendingCheckoutModel = PendingCheckout,
    releaseWithinTransaction = releaseInventoryReservationWithinTransaction,
} = {}) {
    return withCanonicalInventoryTransaction(async (session) => {
        const released = inventoryReservationId
            ? await releaseWithinTransaction({
                businessId,
                reservationId: inventoryReservationId,
                releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_CREATION_FAILED,
                session,
            })
            : { changed: false }
        const update = await PendingCheckoutModel.updateOne(
            { _id: pendingCheckoutId, businessId },
            {
                $set: {
                    status: "creation_failed",
                    stripeCreationFailureCode: failureCode || "stripe_create_failed",
                },
            },
            { session },
        )
        if (update.matchedCount !== 1) {
            const error = new Error("PendingCheckout was not found during Stripe failure compensation")
            error.code = "PENDING_CHECKOUT_COMPENSATION_MISSING"
            throw error
        }
        return { released: released.changed, pendingUpdated: true }
    })
}

/**
 * Reconcile one held Stripe reservation. If the original create response was
 * lost, the exact persisted request is replayed with the same Stripe
 * idempotency key. Stripe returns the original Session rather than creating a
 * second one. A provider-confirmed expired Session is the only expiry signal
 * that releases the hold.
 */
export async function reconcileInventoryReservation({
    businessId,
    reservationId,
    now = new Date(),
}, {
    stripeClient = defaultStripeClient,
    InventoryReservationModel = InventoryReservation,
    PendingCheckoutModel = PendingCheckout,
    persistLink = persistStripeCheckoutLink,
    releaseReservation = releaseInventoryReservation,
    compensateCreationFailure = compensateStripeCheckoutCreationFailure,
    invalidateMenu = invalidateMenuItems,
} = {}) {
    if (!stripeClient) {
        const error = new Error("Stripe is not configured for inventory reconciliation")
        error.code = "STRIPE_NOT_CONFIGURED"
        throw error
    }
    const reservation = await InventoryReservationModel.findOne({
        businessId,
        reservationId,
    })
    if (!reservation) return { skipped: true, reason: "reservation_not_found" }
    if (reservation.status !== INVENTORY_RESERVATION_STATUSES.HELD) {
        return { skipped: true, reason: "reservation_not_held" }
    }
    const pending = await PendingCheckoutModel.findOne({
        _id: reservation.pendingCheckoutId,
        businessId,
        inventoryReservationId: reservation.reservationId,
    })
    if (!pending) {
        const error = new Error("Held inventory reservation has no PendingCheckout")
        error.code = "INVENTORY_PENDING_CHECKOUT_MISSING"
        throw error
    }

    let checkoutSession
    if (reservation.stripeSessionId || pending.stripeSessionId) {
        checkoutSession = await stripeClient.checkout.sessions.retrieve(
            reservation.stripeSessionId || pending.stripeSessionId,
        )
    } else {
        if (!pending.stripeRequestSnapshot || !pending.stripeRequestIdempotencyKey) {
            const error = new Error("PendingCheckout has no crash-recovery Stripe request snapshot")
            error.code = "STRIPE_REQUEST_SNAPSHOT_MISSING"
            throw error
        }
        try {
            checkoutSession = await stripeClient.checkout.sessions.create(
                plain(pending.stripeRequestSnapshot),
                { idempotencyKey: pending.stripeRequestIdempotencyKey },
            )
        } catch (error) {
            if (!isDefinitiveStripeCreationFailure(error)) throw error
            const compensated = await compensateCreationFailure({
                businessId,
                pendingCheckoutId: pending._id,
                inventoryReservationId: reservationId,
                failureCode: error.code || error.type || "stripe_invalid_request",
            })
            if (compensated.released) await invalidateMenu(businessId)
            return { released: compensated.released, reason: "provider_creation_failed" }
        }
    }

    await persistLink({
        businessId,
        pendingCheckoutId: pending._id,
        inventoryReservationId: reservation.reservationId,
        stripeSession: checkoutSession,
    }, { PendingCheckoutModel, InventoryReservationModel })

    if (checkoutSession.status === "expired") {
        const released = await releaseReservation({
            businessId,
            reservationId,
            expectedStripeSessionId: checkoutSession.id,
            releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_VERIFIED_EXPIRED,
        })
        if (released.changed) await invalidateMenu(businessId)
        return { released: released.changed, providerState: "expired" }
    }
    if (checkoutSession.status === "complete" && checkoutSession.payment_status === "paid") {
        return {
            released: false,
            providerState: "paid_awaiting_webhook",
            checkoutSessionId: checkoutSession.id,
        }
    }
    return {
        released: false,
        providerState: checkoutSession.status || "unknown",
        checkoutSessionId: checkoutSession.id,
        checkedAt: now,
    }
}

export async function runInventoryReservationRepairScan({
    now = new Date(),
    limit = INVENTORY_REPAIR_SCAN_LIMIT,
} = {}, {
    InventoryReservationModel = InventoryReservation,
    reconcile = reconcileInventoryReservation,
} = {}) {
    const providerCreationCutoff = new Date(
        now.getTime() - INVENTORY_PROVIDER_CREATION_REPAIR_DELAY_MS,
    )
    const reservations = await InventoryReservationModel.find({
        status: INVENTORY_RESERVATION_STATUSES.HELD,
        $or: [
            {
                stripeSessionId: null,
                providerCreationStartedAt: { $lte: providerCreationCutoff },
            },
            {
                stripeSessionId: { $type: "string" },
                expiresAt: { $lte: now },
            },
        ],
    }).sort({ createdAt: 1, _id: 1 }).limit(Math.min(limit, INVENTORY_REPAIR_SCAN_LIMIT)).lean()

    const results = []
    for (const reservation of reservations) {
        try {
            results.push(await reconcile({
                businessId: reservation.businessId,
                reservationId: reservation.reservationId,
                now,
            }))
        } catch (error) {
            results.push({
                failed: true,
                reservationId: reservation.reservationId,
                reason: error?.code || error?.name || "reconciliation_failed",
            })
        }
    }
    return {
        scannedCount: reservations.length,
        releasedCount: results.filter((result) => result.released).length,
        failedCount: results.filter((result) => result.failed).length,
        results,
    }
}
