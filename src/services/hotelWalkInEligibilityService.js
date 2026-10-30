import Business from "../models/Business.js";
import {
  RESERVATION_ELIGIBLE_BUSINESS_STATUS,
} from "./reservationEligibilityService.js";
import {
  isOfflinePaymentMethodEnabled,
  isPaymentChannelEnabled,
  isStaffOfflinePaymentMethod,
} from "../utils/restaurantOrderValidation.js";

export const HOTEL_WALK_IN_ELIGIBILITY_MESSAGES = Object.freeze({
  unavailable: "This hotel is currently unable to accept new reservations.",
  billing: "Walk-in bookings aren't available yet. The hotel needs to complete its billing setup.",
  paymentMethod: "This offline payment method is not enabled for this hotel.",
});

export class HotelWalkInEligibilityError extends Error {
  constructor(message, { code, statusCode = 403 } = {}) {
    super(message);
    this.name = "HotelWalkInEligibilityError";
    this.code = code || "HOTEL_WALK_IN_UNAVAILABLE";
    this.statusCode = statusCode;
  }
}

function hasSavedBillingMethod(business) {
  return typeof business?.defaultPaymentMethodId === "string" &&
    business.defaultPaymentMethodId.trim().length > 0;
}

export function getEnabledHotelWalkInPaymentMethods(business) {
  return ["cash", "pos_card"].filter((paymentMethod) => (
    isOfflinePaymentMethodEnabled(business, paymentMethod)
  ));
}

export function getHotelWalkInEligibility(business, { paymentMethod } = {}) {
  if (business?.status !== RESERVATION_ELIGIBLE_BUSINESS_STATUS) {
    return {
      eligible: false,
      code: "BUSINESS_RESERVATIONS_UNAVAILABLE",
      message: HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.unavailable,
    };
  }

  if (
    business?.billingStatus !== "active" ||
    !hasSavedBillingMethod(business) ||
    !isPaymentChannelEnabled(business, "offline")
  ) {
    return {
      eligible: false,
      code: "HOTEL_WALK_IN_BILLING_UNAVAILABLE",
      message: HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.billing,
    };
  }

  const enabledPaymentMethods = getEnabledHotelWalkInPaymentMethods(business);
  if (paymentMethod == null && enabledPaymentMethods.length === 0) {
    return {
      eligible: false,
      code: "HOTEL_WALK_IN_PAYMENT_METHOD_UNAVAILABLE",
      message: HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.paymentMethod,
    };
  }

  if (paymentMethod != null && (!isStaffOfflinePaymentMethod(paymentMethod) || !enabledPaymentMethods.includes(paymentMethod))) {
    return {
      eligible: false,
      code: "HOTEL_WALK_IN_PAYMENT_METHOD_UNAVAILABLE",
      message: HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.paymentMethod,
    };
  }

  return { eligible: true, code: null, message: null };
}

export function assertHotelWalkInEligibility(business, options) {
  const eligibility = getHotelWalkInEligibility(business, options);
  if (!eligibility.eligible) {
    throw new HotelWalkInEligibilityError(eligibility.message, eligibility);
  }
  return business;
}

function offlinePaymentEnabledFilter() {
  return {
    $or: [
      { "paymentPreferences.acceptOfflinePayments": true },
      {
        "paymentPreferences.acceptOfflinePayments": { $exists: false },
        "settings.offlinePaymentEnabled": { $ne: false },
      },
    ],
  };
}

function offlineMethodEnabledFilter(paymentMethod) {
  const preferenceField = paymentMethod === "cash"
    ? "paymentPreferences.acceptCash"
    : "paymentPreferences.acceptPosCard";
  const legacyField = paymentMethod === "cash" ? "settings.acceptCash" : "settings.acceptPOS";

  return {
    $or: [
      { [preferenceField]: true },
      { [preferenceField]: { $exists: false }, [legacyField]: { $ne: false } },
    ],
  };
}

/**
 * Acquire the hotel walk-in eligibility fence inside an existing transaction.
 * Unlike the public reservation fence, onboarding completion and Stripe Connect
 * are deliberately not predicates: cash/POS reception bookings use platform
 * billing readiness instead.
 */
export async function acquireHotelWalkInEligibilityFence({
  businessId,
  paymentMethod,
  session,
  businessModel = Business,
  now = new Date(),
} = {}) {
  if (!businessId || !isStaffOfflinePaymentMethod(paymentMethod)) {
    throw new HotelWalkInEligibilityError(
      HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.unavailable,
      { code: "HOTEL_WALK_IN_UNAVAILABLE", statusCode: 403 },
    );
  }

  const query = businessModel.findOneAndUpdate(
    {
      businessId,
      status: RESERVATION_ELIGIBLE_BUSINESS_STATUS,
      billingStatus: "active",
      defaultPaymentMethodId: { $type: "string", $regex: /\S/ },
      $and: [offlinePaymentEnabledFilter(), offlineMethodEnabledFilter(paymentMethod)],
    },
    {
      $inc: { reservationEligibilityVersion: 1 },
      $set: { reservationEligibilityCheckedAt: now },
    },
    { new: true, ...(session ? { session } : {}) },
  );
  const business = typeof query?.lean === "function" ? await query.lean() : await query;
  if (!business) {
    throw new HotelWalkInEligibilityError(
      HOTEL_WALK_IN_ELIGIBILITY_MESSAGES.billing,
      { code: "HOTEL_WALK_IN_BILLING_UNAVAILABLE", statusCode: 403 },
    );
  }
  return business;
}
