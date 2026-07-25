import { calculateOnlinePricing, getCustomerPricingBreakdown } from "./pricingService.js";

export const RESERVATION_PRICING_VERSION = 1;

export function getAccommodationSubtotalCents(reservation) {
  const pricePerNight = Number(reservation?.pricePerNight);
  const numberOfNights = Number(reservation?.numberOfNights);

  if (
    Number.isFinite(pricePerNight) &&
    pricePerNight > 0 &&
    Number.isInteger(numberOfNights) &&
    numberOfNights > 0
  ) {
    return Math.round(Number((pricePerNight * numberOfNights).toFixed(2)) * 100);
  }

  const storedSubtotal = Number(reservation?.subtotal);
  if (Number.isFinite(storedSubtotal) && storedSubtotal > 0) {
    return Math.round(storedSubtotal * 100);
  }

  throw new TypeError("Reservation does not have a valid accommodation subtotal");
}

export async function buildReservationPricingSnapshot({
  reservation,
  business,
  commissionCalculator,
}) {
  const pricing = await calculateOnlinePricing({
    subtotalCents: getAccommodationSubtotalCents(reservation),
    business,
    ...(commissionCalculator ? { commissionCalculator } : {}),
  });

  return {
    pricingSnapshotVersion: RESERVATION_PRICING_VERSION,
    subtotal: pricing.subtotal,
    taxRateApplied: pricing.taxRate,
    taxLabel: pricing.taxLabel,
    taxAmount: pricing.taxAmount,
    taxAmountCents: pricing.taxAmountCents,
    platformFeeLabel: pricing.platformFeeLabel,
    platformFeeTotal: pricing.customerPlatformFeeAmount,
    platformFeeCents: pricing.platformFeeCents,
    customerPlatformFeeCents: pricing.customerPlatformFeeCents,
    businessAbsorbedPlatformFeeCents:
      pricing.businessAbsorbedPlatformFeeCents,
    platformFeeMode: pricing.platformFeeMode,
    customerPlatformFeePercent: pricing.customerPlatformFeePercent,
    planApplied: pricing.planApplied,
    commissionRateApplied: pricing.commissionRateApplied,
    commissionAmountCents: pricing.commissionAmountCents,
    planAtOrder: pricing.planApplied,
    commissionRateAtOrder: pricing.commissionRateApplied,
    platformFeeRateAtOrder: pricing.commissionRateApplied,
    grossAmount: pricing.grossAmountCents,
    netToBusinessAmount: pricing.netToBusinessAmountCents,
    totalPrice: pricing.total,
  };
}

export function hasReservationPricingSnapshot(reservation) {
  return (
    Number(reservation?.pricingSnapshotVersion) >= RESERVATION_PRICING_VERSION &&
    Number.isFinite(Number(reservation?.subtotal)) &&
    Number.isSafeInteger(Number(reservation?.grossAmount)) &&
    Number(reservation?.grossAmount) > 0
  );
}

export async function ensureReservationPricingSnapshot({
  reservation,
  business,
  save = true,
}) {
  if (hasReservationPricingSnapshot(reservation)) {
    return reservation;
  }

  // Never rewrite the amount of a historical payment made before pricing
  // snapshots existed.
  if (reservation?.paymentStatus === "paid") {
    return reservation;
  }

  const snapshot = await buildReservationPricingSnapshot({
    reservation,
    business,
  });
  Object.assign(reservation, snapshot);

  if (save && typeof reservation.save === "function") {
    await reservation.save();
  }

  return reservation;
}

export function getCustomerReservationPricing(reservation) {
  if (hasReservationPricingSnapshot(reservation)) {
    return getCustomerPricingBreakdown({
      subtotal: Number(reservation.subtotal || 0),
      subtotalCents: Math.round(Number(reservation.subtotal || 0) * 100),
      taxRate: Number(reservation.taxRateApplied || 0),
      taxLabel: reservation.taxLabel || "Tax",
      taxAmount: Number(reservation.taxAmount || 0),
      taxAmountCents: Number(
        reservation.taxAmountCents ??
        Math.round(Number(reservation.taxAmount || 0) * 100)
      ),
      platformFeeLabel: reservation.platformFeeLabel || "Platform Fee",
      customerPlatformFeeAmount: Number(
        reservation.platformFeeTotal ??
        (Number(reservation.customerPlatformFeeCents || 0) / 100)
      ),
      customerPlatformFeeCents: Number(
        reservation.customerPlatformFeeCents || 0
      ),
      total: Number(reservation.totalPrice || 0),
      totalCents: Number(reservation.grossAmount || 0),
    });
  }

  // Legacy paid reservations were charged their old totalPrice with no tax or
  // customer fee. Preserve and display that historical amount as accommodation.
  const legacyTotal = Number(reservation?.totalPrice || 0);
  const legacyTotalCents = Math.round(legacyTotal * 100);
  return {
    subtotal: legacyTotal,
    subtotalCents: legacyTotalCents,
    taxRate: 0,
    taxLabel: "Tax",
    taxAmount: 0,
    taxAmountCents: 0,
    platformFeeLabel: reservation?.platformFeeLabel || "Platform Fee",
    customerPlatformFeeAmount: 0,
    customerPlatformFeeCents: 0,
    total: legacyTotal,
    totalCents: legacyTotalCents,
  };
}

export function buildReservationStripeLineItems({
  pricing,
  currency,
  businessName,
}) {
  const normalizedCurrency = String(currency || "eur").toLowerCase();
  const lineItems = [{
    price_data: {
      currency: normalizedCurrency,
      product_data: {
        name: `Accommodation at ${businessName}`,
      },
      unit_amount: pricing.subtotalCents,
    },
    quantity: 1,
  }];

  if (pricing.taxAmountCents > 0) {
    lineItems.push({
      price_data: {
        currency: normalizedCurrency,
        product_data: { name: pricing.taxLabel || "Tax" },
        unit_amount: pricing.taxAmountCents,
      },
      quantity: 1,
    });
  }

  if (pricing.customerPlatformFeeCents > 0) {
    lineItems.push({
      price_data: {
        currency: normalizedCurrency,
        product_data: {
          name: pricing.platformFeeLabel || "Platform Fee",
        },
        unit_amount: pricing.customerPlatformFeeCents,
      },
      quantity: 1,
    });
  }

  return lineItems;
}
