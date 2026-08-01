import Stripe from "stripe";
import Business from "../models/Business.js";
import {
  cancelHotelReservation,
  ReservationCancellationError,
} from "../services/reservationCancellationService.js";
import {
  sendReservationCancelledEmail,
} from "../utils/emailService.js";
import { toOwnerReservationResponse } from "./reservationController.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function toRefundResponse(refund) {
  if (!refund) return null;
  const source = refund.toObject ? refund.toObject() : refund;
  return {
    refundId: source.refundId,
    status: source.status,
    type: source.type,
    requestedAmountCents: source.requestedAmountCents,
    successfulAmountCents: source.successfulAmountCents,
    currency: source.currency,
    reason: source.reason,
    requestedAt: source.requestedAt,
    succeededAt: source.succeededAt,
    failedAt: source.failedAt,
    providerRefundId: source.providerRefundId,
    failureCode: source.failureCode,
    failureMessage: source.failureMessage,
  };
}

/**
 * Explicit hotel cancellation operation. The client selects a business
 * outcome; it never supplies reservation or payment statuses directly.
 */
export async function cancelOwnerHotelReservation(req, res) {
  try {
    const businessId = req.session?.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await cancelHotelReservation({
      businessId,
      reservationId: req.params.id,
      user: req.session.user,
      outcome: req.body?.outcome,
      refundAmountCents: req.body?.refundAmountCents,
      reason: req.body?.reason,
      notes: req.body?.notes,
      clientIdempotencyKey: req.get("Idempotency-Key"),
      stripeClient: req.app?.locals?.stripe || stripe,
    });

    let emailStatus = result.emailSent ? "sent" : "not_sent";
    if (!result.refund && result.reservation?.email && !result.idempotent) {
      const business = await Business.findOne({ businessId }).lean();
      if (business) {
        const sent = await sendReservationCancelledEmail({
          to: result.reservation.email,
          businessName: business.displayName || business.name,
          businessLogoUrl:
            business.branding?.logoUrl || business.logoUrl,
          primaryColor: business.branding?.primaryColor,
          reservation: result.reservation.toObject
            ? result.reservation.toObject()
            : result.reservation,
        });
        emailStatus = sent ? "sent" : "failed";
      }
    }

    return res.status(result.pending ? 202 : 200).json({
      message: result.pending
        ? "Stripe is processing the refund. The reservation remains confirmed until the refund succeeds."
        : result.refund
          ? "Reservation cancelled and refund confirmed."
          : "Reservation cancelled.",
      reservation: result.reservation
        ? toOwnerReservationResponse(result.reservation)
        : null,
      refund: toRefundResponse(result.refund),
      refundPending: Boolean(result.pending),
      idempotent: Boolean(result.idempotent),
      emailStatus,
    });
  } catch (error) {
    if (error instanceof ReservationCancellationError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    console.error(
      "[reservationCancellationController.cancelOwnerHotelReservation] Error:",
      error,
    );
    return res.status(500).json({ error: "Server error" });
  }
}
