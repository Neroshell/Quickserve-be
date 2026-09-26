import { getBusinessCurrency } from "../utils/restaurantOrderValidation.js";

/**
 * ARCH-007: Canonical Order Construction
 *
 * Pure, deterministic mapping function that assembles the shared order snapshot
 * from pre-validated, pre-resolved inputs. This function:
 *
 * - Does NOT call normalizeTip (caller resolves tip first)
 * - Does NOT call buildOrderEstimate (caller resolves estimate first)
 * - Does NOT call resolveOrStartCustomerJourney (caller resolves journey first)
 * - Does NOT call buildInventoryRequestFingerprint (caller resolves fingerprint first)
 * - Does NOT perform any I/O, database access, or side effects
 *
 * The builder owns ONLY the shared field mapping from authoritative validated
 * inputs into the canonical order/checkout snapshot shape. Channel-specific
 * fields (status, paymentChannel, paymentStatus, paidVia, orderSource,
 * createdBy, createdByStaffId, idempotency keys, Stripe metadata) are NOT
 * included and must be spread in by the caller.
 */
export function buildCanonicalOrderDraft({
    business,
    orderId,
    servicePointId,
    displayLabel,
    orderType,
    sessionId,
    guestSessionId,
    enrichedItems,

    // Pre-resolved financial values (from pricingService + normalizeTip)
    subtotal,
    taxAmount,
    tip, // { tipAmount, tipType, tipPercentage } — from normalizeTip
    total, // authoritative total from pricing.total or manual summation
    currency, // from getBusinessCurrency(business) — caller decides casing

    // Pre-resolved fee/commission snapshot (from pricingService)
    platformFeeTotal, // customerPlatformFeeFloat (display amount)
    platformFeeCents, // fullPlatformFeeCents
    customerPlatformFeeCents,
    businessAbsorbedPlatformFeeCents,
    platformFeeMode, // "business_absorbs" | "customer_pays" | etc.
    customerPlatformFeePercent,
    commissionAmountCents,
    commissionRateApplied,
    planApplied,

    // Pre-resolved prep estimates (from buildOrderEstimate)
    estimatedPrepMinutes,
    estimatedReadyAt,

    // Pre-resolved journey (from resolveOrStartCustomerJourney)
    journeyId,

    // Optional
    receiptEmail,
}) {
    return {
        // Base identities
        businessId: business.businessId,
        orderId,
        servicePointId,
        displayLabel,
        orderType,
        sessionId,
        guestSessionId,
        journeyId: journeyId ?? null,

        // Canonical items
        items: enrichedItems,

        // Financials
        subtotal,
        taxAmount,
        tipAmount: tip.tipAmount,
        tipType: tip.tipType,
        tipPercentage: tip.tipPercentage,
        total,
        currency: currency ?? getBusinessCurrency(business),

        // Fees & Commissions (frozen snapshot)
        platformFeeTotal: platformFeeTotal ?? 0,
        platformFeeCents: platformFeeCents ?? 0,
        customerPlatformFeeCents: customerPlatformFeeCents ?? 0,
        businessAbsorbedPlatformFeeCents: businessAbsorbedPlatformFeeCents ?? 0,
        platformFeeMode: platformFeeMode ?? "business_absorbs",
        customerPlatformFeePercent: customerPlatformFeePercent ?? 0,
        commissionAmountCents: commissionAmountCents ?? 0,
        commissionRateApplied: commissionRateApplied ?? 0,
        planApplied: planApplied ?? null,
        planAtOrder: planApplied ?? null,
        commissionRateAtOrder: commissionRateApplied ?? 0,
        platformFeeRateAtOrder: commissionRateApplied ?? 0,

        // Estimates
        estimatedPrepMinutes: estimatedPrepMinutes ?? null,
        estimatedReadyAt: estimatedReadyAt ?? null,

        // Common CRM/Receipt
        receiptEmail: receiptEmail || null,
    };
}
