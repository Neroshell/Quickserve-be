export const HOTEL_ONLINE_PAYMENT_NOT_READY_MESSAGE =
  "Online payments aren't ready yet. Complete Stripe setup before accepting this booking request.";

export class HotelOnlinePaymentReadinessError extends Error {
  constructor(message = HOTEL_ONLINE_PAYMENT_NOT_READY_MESSAGE, { statusCode = 409 } = {}) {
    super(message);
    this.name = "HotelOnlinePaymentReadinessError";
    this.code = "HOTEL_ONLINE_PAYMENT_NOT_READY";
    this.statusCode = statusCode;
  }
}

/**
 * The authoritative persisted Stripe Connect readiness used by hotel
 * reservation payment collection. Account capabilities are refreshed by the
 * existing Stripe status controller and account.updated webhook.
 */
export function isHotelOnlinePaymentReady(business) {
  return Boolean(
    typeof business?.stripeAccountId === "string" &&
    business.stripeAccountId.trim() &&
    business.stripeChargesEnabled === true &&
    business.stripePayoutsEnabled === true,
  );
}

export function assertHotelOnlinePaymentReady(business, {
  statusCode = 409,
  message = HOTEL_ONLINE_PAYMENT_NOT_READY_MESSAGE,
} = {}) {
  if (!isHotelOnlinePaymentReady(business)) {
    throw new HotelOnlinePaymentReadinessError(message, { statusCode });
  }
  return business;
}
