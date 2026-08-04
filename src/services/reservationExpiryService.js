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
    paymentStatus: { $ne: "paid" },
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

export async function runReservationExpiryRepairScan(options = {}) {
  const result = await expireAwaitingPaymentReservations({
    ...options,
    allTenants: options.businessId ? false : true,
  });
  return {
    matchedCount: Number(result?.matchedCount || 0),
    expiredCount: Number(result?.modifiedCount || 0),
  };
}

function normalizeExpiry(value) {
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) {
    throw new TypeError("expectedPaymentExpiry must be a valid date");
  }
  return expiry;
}

async function resolveQuery(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

/**
 * Expires one reservation only when the tenant, state, payment truth, and
 * persisted payment-expiry version still match the delayed job payload.
 */
export async function expireReservationPaymentWindow({
  businessId,
  reservationId,
  expectedPaymentExpiry,
  now = new Date(),
  reservationModel = Reservation,
} = {}) {
  if (!businessId || !reservationId) {
    throw new TypeError("businessId and reservationId are required");
  }
  const expectedExpiry = normalizeExpiry(expectedPaymentExpiry);
  const current = await resolveQuery(reservationModel.findOne({
    _id: reservationId,
    businessId,
  }));

  if (!current) {
    return { expired: false, skipped: true, reason: "reservation_not_found" };
  }
  if (current.status !== "accepted_awaiting_payment") {
    return { expired: false, skipped: true, reason: "status_changed" };
  }
  if (current.paymentStatus === "paid") {
    return { expired: false, skipped: true, reason: "already_paid" };
  }

  const currentExpiry = current.paymentExpiresAt
    ? new Date(current.paymentExpiresAt)
    : null;
  if (
    !currentExpiry ||
    Number.isNaN(currentExpiry.getTime()) ||
    currentExpiry.getTime() !== expectedExpiry.getTime()
  ) {
    return { expired: false, skipped: true, reason: "expiry_changed" };
  }
  if (expectedExpiry > now) {
    const error = new Error("Reservation expiry job executed before its deadline");
    error.code = "RESERVATION_EXPIRY_NOT_DUE";
    throw error;
  }

  const updated = await reservationModel.findOneAndUpdate(
    {
      _id: reservationId,
      businessId,
      status: "accepted_awaiting_payment",
      paymentStatus: { $ne: "paid" },
      paymentExpiresAt: expectedExpiry,
    },
    { $set: { status: "expired" } },
    { new: true, runValidators: true },
  );

  if (!updated) {
    return { expired: false, skipped: true, reason: "state_changed" };
  }
  return { expired: true, skipped: false, reservationId: String(reservationId) };
}
