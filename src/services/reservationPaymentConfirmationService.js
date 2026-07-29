/**
 * Apply the authoritative reservation payment facts to an already validated
 * Reservation document. The first confirmation timestamp is immutable so a
 * retried Stripe webhook cannot rewrite the lifecycle event.
 */
export function applyReservationPaymentConfirmation(
    reservation,
    {
        checkoutSessionId,
        paymentIntentId = null,
        amountPaidCents,
        confirmedAt = new Date(),
    }
) {
    reservation.paymentStatus = "paid";
    reservation.status = "confirmed";
    reservation.stripeCheckoutSessionId =
        checkoutSessionId;
    reservation.stripePaymentIntentId =
        paymentIntentId;
    if (!reservation.paidAt) {
        reservation.paidAt = confirmedAt;
    }
    if (!reservation.confirmedAt) {
        reservation.confirmedAt = confirmedAt;
    }
    reservation.amountPaidCents = amountPaidCents;
    return reservation;
}
