import Reservation from "../models/Reservation.js";

export function buildReservationExpiryFilter({
  businessId,
  now = new Date(),
  allTenants = false,
} = {}) {
  if (!businessId && !allTenants) {
    throw new Error(
      "businessId is required unless a trusted all-tenant expiry job is running.",
    );
  }

  return {
    ...(businessId ? { businessId } : {}),
    status: "accepted_awaiting_payment",
    paymentExpiresAt: { $lte: now },
  };
}

/**
 * Atomically expires accepted reservations whose payment window has elapsed.
 * Owner-facing callers must provide businessId; only the authenticated cron
 * job may opt into the cross-tenant sweep.
 */
export function expireAwaitingPaymentReservations({
  businessId,
  now = new Date(),
  allTenants = false,
  reservationModel = Reservation,
} = {}) {
  return reservationModel.updateMany(
    buildReservationExpiryFilter({ businessId, now, allTenants }),
    { $set: { status: "expired" } },
  );
}
