import {
  calculateOfflineCommission,
  calculateOnlineCommission,
} from "../utils/platformFee.js";

const DEFAULT_PLATFORM_FEE_LABEL = "Platform Fee";
const DEFAULT_TAX_LABEL = "Tax";

function assertMinorUnitAmount(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
}

function toCurrencyAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

/**
 * Pure pricing calculation used after the applicable plan commission has been
 * resolved. The rounding order deliberately matches the existing menu checkout.
 */
export function calculatePricingBreakdown({
  subtotalCents,
  taxRate = 0,
  tipAmountCents = 0,
  commissionAmountCents = 0,
  commissionRateApplied = 0,
  planApplied = "basic",
  business = {},
}) {
  assertMinorUnitAmount(subtotalCents, "subtotalCents");
  assertMinorUnitAmount(tipAmountCents, "tipAmountCents");
  assertMinorUnitAmount(commissionAmountCents, "commissionAmountCents");

  const normalizedTaxRate = Number.isFinite(Number(taxRate))
    ? Math.max(0, Number(taxRate))
    : 0;
  const subtotal = toCurrencyAmount(subtotalCents);

  // Preserve the menu flow's calculation order:
  // subtotal -> percentage -> two decimal places -> integer minor units.
  const taxAmount = Number((subtotal * (normalizedTaxRate / 100)).toFixed(2));
  const taxAmountCents = Math.round(taxAmount * 100);

  const platformFeeMode =
    business.platformFeeMode ||
    (business.passPlatformFeeToCustomer ? "customer_pays" : "business_absorbs");
  const customerPlatformFeePercent =
    platformFeeMode === "split"
      ? Number(business.customerPlatformFeePercent || 0)
      : platformFeeMode === "customer_pays"
        ? 100
        : 0;

  const customerPlatformFeeCents = Math.round(
    commissionAmountCents * customerPlatformFeePercent / 100
  );
  const businessAbsorbedPlatformFeeCents =
    commissionAmountCents - customerPlatformFeeCents;
  const grossAmountCents =
    subtotalCents + taxAmountCents + tipAmountCents + customerPlatformFeeCents;
  const netToBusinessAmountCents =
    subtotalCents + taxAmountCents + tipAmountCents -
    businessAbsorbedPlatformFeeCents;

  return {
    subtotal,
    subtotalCents,
    taxRate: normalizedTaxRate,
    taxLabel: DEFAULT_TAX_LABEL,
    taxAmount,
    taxAmountCents,
    tipAmount: toCurrencyAmount(tipAmountCents),
    tipAmountCents,
    platformFeeLabel:
      business.platformFeeLabel || DEFAULT_PLATFORM_FEE_LABEL,
    platformFeeMode,
    customerPlatformFeePercent,
    platformFeeCents: commissionAmountCents,
    commissionAmountCents,
    customerPlatformFeeCents,
    customerPlatformFeeAmount: toCurrencyAmount(customerPlatformFeeCents),
    businessAbsorbedPlatformFeeCents,
    businessAbsorbedPlatformFeeAmount:
      toCurrencyAmount(businessAbsorbedPlatformFeeCents),
    commissionRateApplied,
    planApplied,
    grossAmountCents,
    grossAmount: toCurrencyAmount(grossAmountCents),
    totalCents: grossAmountCents,
    total: toCurrencyAmount(grossAmountCents),
    netToBusinessAmountCents,
    netToBusinessAmount: toCurrencyAmount(netToBusinessAmountCents),
  };
}

/**
 * Resolves the channel-specific plan commission and returns the complete
 * customer and settlement breakdown. Commission remains based on subtotal only.
 */
async function calculatePricing({
  subtotalCents,
  business,
  tipAmountCents = 0,
  commissionCalculator,
  normalizeCommissionAmount,
}) {
  assertMinorUnitAmount(subtotalCents, "subtotalCents");
  const planSlug = business?.currentPlan || business?.plan || "basic";
  const commission = await commissionCalculator(subtotalCents, planSlug);
  const commissionAmountCents = normalizeCommissionAmount
    ? normalizeCommissionAmount(subtotalCents, commission)
    : commission.commissionAmountCents;

  return calculatePricingBreakdown({
    subtotalCents,
    taxRate: business?.taxRate || 0,
    tipAmountCents,
    commissionAmountCents,
    commissionRateApplied: commission.commissionRateApplied,
    planApplied: commission.planApplied,
    business,
  });
}

export function calculateOnlinePricing(options) {
  return calculatePricing({
    ...options,
    commissionCalculator:
      options.commissionCalculator || calculateOnlineCommission,
  });
}

export function calculateOfflinePricing(options) {
  return calculatePricing({
    ...options,
    commissionCalculator:
      options.commissionCalculator || calculateOfflineCommission,
    // Preserve the established offline order rounding sequence exactly:
    // currency subtotal -> percentage -> two decimals -> minor units.
    normalizeCommissionAmount: (subtotalCents, commission) => {
      const subtotal = toCurrencyAmount(subtotalCents);
      const roundedAmount = Number(
        (subtotal * (commission.commissionRateApplied / 100)).toFixed(2)
      );
      return Math.round(roundedAmount * 100);
    },
  });
}

export function getCustomerPricingBreakdown(pricing) {
  return {
    subtotal: pricing.subtotal,
    subtotalCents: pricing.subtotalCents,
    taxRate: pricing.taxRate,
    taxLabel: pricing.taxLabel,
    taxAmount: pricing.taxAmount,
    taxAmountCents: pricing.taxAmountCents,
    platformFeeLabel: pricing.platformFeeLabel,
    customerPlatformFeeAmount: pricing.customerPlatformFeeAmount,
    customerPlatformFeeCents: pricing.customerPlatformFeeCents,
    total: pricing.total,
    totalCents: pricing.totalCents,
  };
}
