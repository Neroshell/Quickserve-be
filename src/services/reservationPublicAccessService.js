import mongoose from "mongoose";

import Business from "../models/Business.js";
import PendingCheckout from "../models/PendingCheckout.js";
import Reservation from "../models/Reservation.js";
import { getCustomerReservationPricing } from "./reservationPricingService.js";

const CONFIRMATION_RETENTION_DAYS = 30;
const ACTIVE_CONFIRMATION_ATTEMPT_STATUSES = new Set(["open", "completed"]);
const SETTLED_PAYMENT_STATUSES = new Set([
  "paid",
  "partially_refunded",
  "refunded",
]);
const PAYMENT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CHECKOUT_SESSION_PATTERN = /^cs_[A-Za-z0-9_]{6,252}$/;

const RESERVATION_PUBLIC_SELECT = [
  "publicReference",
  "businessId",
  "email",
  "date",
  "startTime",
  "endTime",
  "guestCount",
  "servicePointLabel",
  "roomTypeSnapshot",
  "checkInDate",
  "checkOutDate",
  "paymentExpiresAt",
  "pricePerNight",
  "numberOfNights",
  "subtotal",
  "taxRateApplied",
  "taxLabel",
  "taxAmount",
  "taxAmountCents",
  "platformFeeLabel",
  "platformFeeTotal",
  "customerPlatformFeeCents",
  "totalPrice",
  "grossAmount",
  "currency",
  "paymentStatus",
  "status",
  "verificationCode",
  "stripeSessionId",
  "stripeCheckoutSessionId",
].join(" ");

const BUSINESS_PUBLIC_SELECT = [
  "name",
  "displayName",
  "logoUrl",
  "currency",
  "countryCode",
  "slug",
].join(" ");

export const PUBLIC_RESERVATION_LINK_ERROR =
  "This reservation link is invalid or no longer available.";

export class PublicReservationAccessError extends Error {
  constructor() {
    super(PUBLIC_RESERVATION_LINK_ERROR);
    this.name = "PublicReservationAccessError";
    this.code = "PUBLIC_RESERVATION_ACCESS_DENIED";
    this.statusCode = 404;
  }
}

function denyPublicReservationAccess() {
  throw new PublicReservationAccessError();
}

async function resolveLean(query, selection) {
  let selected = query;
  if (selection && typeof selected?.select === "function") {
    selected = selected.select(selection);
  }
  return typeof selected?.lean === "function" ? selected.lean() : selected;
}

function toDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateOnlyConfirmationExpiry(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, year, month, day] = match;
  const base = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    base.getUTCFullYear() !== Number(year) ||
    base.getUTCMonth() !== Number(month) - 1 ||
    base.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day) + CONFIRMATION_RETENTION_DAYS + 1,
    ),
  );
}

export function getReservationConfirmationAccessExpiresAt(reservation) {
  return dateOnlyConfirmationExpiry(
    reservation?.checkOutDate || reservation?.date,
  );
}

export function maskGuestEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  return `${email[0]}***${email.slice(separator)}`;
}

export function toPublicReservationBusinessDto(business) {
  return {
    displayName: business?.displayName || business?.name || "Business",
    logoUrl: business?.logoUrl || null,
    currency: business?.currency || null,
    countryCode: business?.countryCode || null,
    slug: business?.slug || null,
  };
}

function toPublicReservationBaseDto(reservation) {
  return {
    reference: reservation?.publicReference || null,
    type: reservation?.checkInDate ? "stay" : "timeslot",
    status: reservation?.status || null,
    paymentStatus: reservation?.paymentStatus || null,
    date: reservation?.date || null,
    startTime: reservation?.startTime || null,
    endTime: reservation?.endTime || null,
    checkInDate: reservation?.checkInDate || null,
    checkOutDate: reservation?.checkOutDate || null,
    guestCount: Number(reservation?.guestCount || 0),
    servicePointLabel: reservation?.servicePointLabel || null,
    roomType: reservation?.roomTypeSnapshot || null,
    pricePerNight: Number(reservation?.pricePerNight || 0),
    numberOfNights: Number(reservation?.numberOfNights || 0),
    currency: reservation?.currency || null,
    pricing: getCustomerReservationPricing(reservation),
  };
}

export function toPublicReservationPaymentDto(reservation) {
  return {
    ...toPublicReservationBaseDto(reservation),
    paymentExpiresAt: reservation?.paymentExpiresAt || null,
  };
}

export function toPublicReservationConfirmationDto(reservation) {
  return {
    ...toPublicReservationBaseDto(reservation),
    maskedEmail: maskGuestEmail(reservation?.email),
    verificationCode: reservation?.verificationCode || null,
  };
}

async function getPublicBusiness(businessId, businessModel) {
  const business = await resolveLean(
    businessModel.findOne({ businessId }),
    BUSINESS_PUBLIC_SELECT,
  );
  if (!business) denyPublicReservationAccess();
  return business;
}

export async function resolveReservationPaymentAccess({
  secureToken,
  now = new Date(),
  reservationModel = Reservation,
  businessModel = Business,
} = {}) {
  const normalizedToken = String(secureToken || "").trim();
  if (!PAYMENT_TOKEN_PATTERN.test(normalizedToken)) {
    denyPublicReservationAccess();
  }

  const reservation = await resolveLean(
    reservationModel.findOne({ secureToken: normalizedToken }),
    RESERVATION_PUBLIC_SELECT,
  );
  const paymentExpiry = toDate(reservation?.paymentExpiresAt);
  if (
    !reservation ||
    reservation.status !== "accepted_awaiting_payment" ||
    reservation.paymentStatus === "paid" ||
    !paymentExpiry ||
    paymentExpiry <= now
  ) {
    denyPublicReservationAccess();
  }

  const business = await getPublicBusiness(reservation.businessId, businessModel);
  return {
    reservation: toPublicReservationPaymentDto(reservation),
    business: toPublicReservationBusinessDto(business),
  };
}

export async function resolveReservationConfirmationAccess({
  reservationId,
  checkoutSessionId,
  now = new Date(),
  reservationModel = Reservation,
  pendingCheckoutModel = PendingCheckout,
  businessModel = Business,
} = {}) {
  const normalizedReservationId = String(reservationId || "").trim();
  const normalizedSessionId = String(checkoutSessionId || "").trim();
  if (
    !mongoose.isValidObjectId(normalizedReservationId) ||
    !CHECKOUT_SESSION_PATTERN.test(normalizedSessionId)
  ) {
    denyPublicReservationAccess();
  }

  const attempt = await resolveLean(
    pendingCheckoutModel.findOne({
      checkoutType: "reservation",
      reservationId: normalizedReservationId,
      stripeSessionId: normalizedSessionId,
      status: { $in: [...ACTIVE_CONFIRMATION_ATTEMPT_STATUSES] },
    }),
    "businessId reservationId stripeSessionId stripeExpiresAt status",
  );
  if (!attempt || !ACTIVE_CONFIRMATION_ATTEMPT_STATUSES.has(attempt.status)) {
    denyPublicReservationAccess();
  }

  const reservation = await resolveLean(
    reservationModel.findOne({
      _id: attempt.reservationId,
      businessId: attempt.businessId,
      $or: [
        { stripeSessionId: normalizedSessionId },
        { stripeCheckoutSessionId: normalizedSessionId },
      ],
    }),
    RESERVATION_PUBLIC_SELECT,
  );
  if (!reservation || String(reservation._id) !== normalizedReservationId) {
    denyPublicReservationAccess();
  }

  if (attempt.status === "open") {
    const providerExpiry = toDate(attempt.stripeExpiresAt);
    if (!providerExpiry || providerExpiry <= now) {
      denyPublicReservationAccess();
    }
  } else if (!SETTLED_PAYMENT_STATUSES.has(reservation.paymentStatus)) {
    denyPublicReservationAccess();
  }

  const confirmationExpiry = getReservationConfirmationAccessExpiresAt(reservation);
  if (!confirmationExpiry || confirmationExpiry <= now) {
    denyPublicReservationAccess();
  }

  const business = await getPublicBusiness(attempt.businessId, businessModel);
  return {
    reservation: toPublicReservationConfirmationDto(reservation),
    business: toPublicReservationBusinessDto(business),
  };
}

export {
  ACTIVE_CONFIRMATION_ATTEMPT_STATUSES,
  BUSINESS_PUBLIC_SELECT,
  CONFIRMATION_RETENTION_DAYS,
  RESERVATION_PUBLIC_SELECT,
};
