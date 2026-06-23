import Plan from "../models/Plan.js";

/**
 * Calculates the QuickServe commission for online Stripe payments.
 * Looks up the given planSlug in the Plan collection and uses `commissionPercentage`.
 *
 * @param {number} totalInCents - The gross order total in cents
 * @param {string} planSlug - The business's current plan slug (e.g. "growth")
 * @returns {Promise<{ commissionAmountCents: number, commissionRateApplied: number, planApplied: string }>}
 */
export async function calculateOnlineCommission(totalInCents, planSlug) {
  let slug = planSlug?.toLowerCase() || "basic";
  const planDoc = await Plan.findOne({ slug }).lean();
  const rate = planDoc?.commissionPercentage ?? 0;
  
  const commissionAmountCents = Math.round(totalInCents * (rate / 100));

  console.log(
    `[platformFee] Online Stripe commission resolved — plan="${planDoc?.slug || planSlug}", sourceField="commissionPercentage", rate=${rate}%, total=${totalInCents}c, quickServeFee=${commissionAmountCents}c`
  );

  return {
    commissionAmountCents,
    commissionRateApplied: rate,
    planApplied: planDoc?.slug || planSlug || "basic",
  };
}

/**
 * Calculates the QuickServe commission for offline cash/POS/waiter orders.
 * Looks up the given planSlug in the Plan collection and uses `offlineCommissionRate`.
 *
 * @param {number} totalInCents - The gross order total in cents
 * @param {string} planSlug - The business's current plan slug (e.g. "growth")
 * @returns {Promise<{ commissionAmountCents: number, commissionRateApplied: number, planApplied: string }>}
 */
export async function calculateOfflineCommission(totalInCents, planSlug) {
  let slug = planSlug?.toLowerCase() || "basic";
  const planDoc = await Plan.findOne({ slug }).lean();
  const rate = planDoc?.offlineCommissionRate ?? 0;

  const commissionAmountCents = Math.round(totalInCents * (rate / 100));

  console.log(
    `[platformFee] Offline commission resolved — plan="${planDoc?.slug || planSlug}", sourceField="offlineCommissionRate", rate=${rate}%, total=${totalInCents}c, quickServeCommission=${commissionAmountCents}c`
  );

  return {
    commissionAmountCents,
    commissionRateApplied: rate,
    planApplied: planDoc?.slug || planSlug || "basic",
  };
}

export async function getPlanOnlineCommissionRate(planSlug) {
  let slug = planSlug?.toLowerCase() || "basic";
  const planDoc = await Plan.findOne({ slug }).lean();
  return planDoc?.commissionPercentage ?? 0;
}

export async function getPlanOfflineCommissionRate(planSlug) {
  let slug = planSlug?.toLowerCase() || "basic";
  const planDoc = await Plan.findOne({ slug }).lean();
  return planDoc?.offlineCommissionRate ?? 0;
}

