/**
 * Platform fee rates by business plan.
 * QuickServe deducts this percentage from every online transaction
 * as application_fee_amount in Stripe Connect destination charges.
 *
 * Rates are expressed as decimals (e.g. 0.02 = 2%).
 */
const PLAN_FEE_RATES = {
  basic:      0.03,   // 3%
  starter:    0.025,  // 2.5%
  growth:     0.015,  // 1.5%
  enterprise: 0.01,   // 1%
}

const DEFAULT_FEE_RATE = 0.02 // 2% fallback

/**
 * Returns the platform fee rate (decimal) for a given plan string.
 * @param {string} plan - Business plan name (e.g. "basic", "growth")
 * @returns {number} fee rate as decimal
 */
export function getFeeRate(plan) {
  return PLAN_FEE_RATES[plan?.toLowerCase()] ?? DEFAULT_FEE_RATE
}

/**
 * Calculates the platform fee in cents for a given total amount.
 * @param {number} totalCents - Total order amount in cents
 * @param {string} plan - Business plan name
 * @returns {number} fee in cents (integer, rounded)
 */
export function calculatePlatformFee(totalCents, plan) {
  const rate = getFeeRate(plan)
  return Math.round(totalCents * rate)
}
