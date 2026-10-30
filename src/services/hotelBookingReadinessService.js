import { getConfiguredPublicReservationModes } from "./publicReservationBookabilityService.js";
import { getReservationEligibility } from "./reservationEligibilityService.js";
import {
  getEnabledHotelWalkInPaymentMethods,
  getHotelWalkInEligibility,
} from "./hotelWalkInEligibilityService.js";
import { isHotelOnlinePaymentReady } from "./hotelOnlinePaymentReadinessService.js";

const ACCOMMODATION_NOT_READY = Object.freeze({
  code: "HOTEL_ACCOMMODATION_NOT_READY",
  message: "Complete room setup before accepting new hotel bookings.",
});

function unavailable(code, message, extra = {}) {
  const state = (
    code === "BUSINESS_RESERVATIONS_UNAVAILABLE" ||
    code === "HOTEL_PUBLIC_BOOKING_UNAVAILABLE"
  ) ? "unavailable" : "setup_required";
  return { ready: false, state, code, message, ...extra };
}

/**
 * Read-only owner-facing projection. It composes canonical reservation and
 * payment policies; it is never an authorization substitute for creation,
 * checkout, or their transactional fences.
 */
export function getHotelBookingReadiness({ business, accommodationReady = false } = {}) {
  const walkInEligibility = getHotelWalkInEligibility(business);
  const enabledPaymentMethods = getEnabledHotelWalkInPaymentMethods(business);
  let walkIn;

  if (!accommodationReady) {
    walkIn = unavailable(ACCOMMODATION_NOT_READY.code, ACCOMMODATION_NOT_READY.message, { enabledPaymentMethods });
  } else if (walkInEligibility.eligible) {
    walkIn = { ready: true, state: "ready", code: null, message: "Accept walk-in bookings and record cash or terminal payments.", enabledPaymentMethods };
  } else {
    walkIn = unavailable(walkInEligibility.code, walkInEligibility.message, { enabledPaymentMethods });
  }

  const reservationEligibility = getReservationEligibility(business);
  const publicStayEnabled =
    business?.settings?.reservationsEnabled !== false &&
    getConfiguredPublicReservationModes(business).includes("stay");
  let online;

  if (!accommodationReady) {
    online = unavailable(ACCOMMODATION_NOT_READY.code, ACCOMMODATION_NOT_READY.message);
  } else if (!reservationEligibility.eligible) {
    online = unavailable(reservationEligibility.code, reservationEligibility.message);
  } else if (!publicStayEnabled) {
    online = unavailable(
      "HOTEL_PUBLIC_BOOKING_UNAVAILABLE",
      "Online bookings are currently unavailable. Review your booking settings.",
    );
  } else if (!isHotelOnlinePaymentReady(business)) {
    online = unavailable(
      "HOTEL_ONLINE_PAYMENT_NOT_READY",
      "Connect Stripe to accept online guest payments.",
    );
  } else {
    online = { ready: true, state: "ready", code: null, message: "Accept online guest payments through Chillow." };
  }

  return { walkIn, online };
}
