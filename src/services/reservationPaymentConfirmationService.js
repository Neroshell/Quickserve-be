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

/**
 * Persist the authoritative reservation payment transition with one
 * tenant-scoped conditional update. Stripe facts must be validated before
 * this function is called; expected amount/currency are repeated in the
 * filter to prevent a stale validation result from changing newer state.
 */
export async function confirmReservationPaymentAtomic({
    reservationId,
    businessId,
    expectedAmountCents,
    expectedCurrency,
    checkoutSessionId,
    paymentIntentId = null,
    confirmedAt = new Date(),
    reservationModel,
} = {}) {
    if (!reservationModel) {
        const { default: Reservation } = await import("../models/Reservation.js");
        reservationModel = Reservation;
    }
    const currency = String(expectedCurrency || "").toLowerCase();
    const paid = await reservationModel.findOneAndUpdate(
        {
            _id: reservationId,
            businessId,
            status: "accepted_awaiting_payment",
            paymentStatus: { $ne: "paid" },
            grossAmount: expectedAmountCents,
            currency,
        },
        {
            $set: {
                paymentStatus: "paid",
                status: "confirmed",
                stripeCheckoutSessionId: checkoutSessionId,
                stripePaymentIntentId: paymentIntentId,
                paidAt: confirmedAt,
                confirmedAt,
                amountPaidCents: expectedAmountCents,
            },
        },
        { new: true },
    );
    if (paid) return { transitioned: true, reservation: paid };

    const currentQuery = reservationModel.findOne({
        _id: reservationId,
        businessId,
    });
    const current = typeof currentQuery?.lean === "function"
        ? await currentQuery.lean()
        : await currentQuery;
    if (current?.paymentStatus === "paid") {
        return { transitioned: false, alreadyPaid: true, reservation: current };
    }
    return { transitioned: false, alreadyPaid: false, reservation: current || null };
}
