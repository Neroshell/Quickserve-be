import CommissionAccrual from "../models/CommissionAccrual.js"

export const SUPPORTED_OFFLINE_COMMISSION_CURRENCIES = new Set(["EUR", "GBP", "USD", "CAD", "AUD"])

export function resolveCommissionBillingPeriod(business, at = new Date()) {
    if (business?.currentPeriodStart && business?.currentPeriodEnd) {
        return `${new Date(business.currentPeriodStart).toISOString()}/${new Date(business.currentPeriodEnd).toISOString()}`
    }
    // Calendar fallback is deliberately stable, not a guessed subscription period.
    return at.toISOString().slice(0, 7)
}

export async function recordOfflineCommissionAccrual({ business, sourceType, source, eligibleAmountCents, at = new Date() }) {
    if (!business?.offlineCommissionInvoiceEnabled || !business?.offlineCommissionInvoiceCutoverAt) {
        return { recorded: false, reason: "commission_invoice_cutover_not_enabled" }
    }
    if (source?.commissionReportedToStripe === true) return { recorded: false, reason: "legacy_metered_commission" }
    if (source?.paymentChannel !== "offline" || source?.paymentStatus !== "paid") {
        return { recorded: false, reason: "not_confirmed_offline_payment" }
    }
    if (new Date(source?.paidAt || at) < new Date(business.offlineCommissionInvoiceCutoverAt)) {
        return { recorded: false, reason: "before_cutover" }
    }
    const currency = String(source?.currency || business.currency || "").toUpperCase()
    const billingCurrency = String(business.currency || "").toUpperCase()
    if (!SUPPORTED_OFFLINE_COMMISSION_CURRENCIES.has(currency) || currency !== billingCurrency) {
        return { recorded: false, reason: "unsupported_or_mismatched_currency" }
    }
    const sourceId = String(source?._id || source?.orderId || "")
    const paymentConfirmationId = `${sourceId}:${new Date(source?.paidAt || at).toISOString()}`
    if (!sourceId || !Number.isSafeInteger(eligibleAmountCents) || eligibleAmountCents < 0) throw new TypeError("Valid commission source and minor-unit amount are required")
    const values = {
        businessId: business.businessId,
        sourceType,
        sourceId,
        paymentConfirmationId,
        eligibleAmountCents,
        currency,
        commissionRateApplied: Number(source.commissionRateApplied || 0),
        commissionAmountCents: Number(source.commissionAmountCents || 0),
        billingPeriod: resolveCommissionBillingPeriod(business, new Date(source?.paidAt || at)),
    }
    const accrual = await CommissionAccrual.findOneAndUpdate(
        { businessId: values.businessId, sourceType, sourceId, paymentConfirmationId },
        { $setOnInsert: values },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    return { recorded: true, accrual }
}

// Reuses payment-time validation and the unique source/payment identity, so a
// crash between payment confirmation and this write is repairable without
// creating another commission. Repositories are injected for database tests.
export async function recoverMissingOfflineCommissionAccruals({ business, orders = [], reservations = [] }) {
    const recovered = []
    for (const order of orders) {
        const result = await recordOfflineCommissionAccrual({ business, sourceType: "order", source: order, eligibleAmountCents: Math.round(Number(order.subtotal || 0) * 100) })
        if (result.recorded) recovered.push(result)
    }
    for (const reservation of reservations) {
        const result = await recordOfflineCommissionAccrual({ business, sourceType: "reservation", source: reservation, eligibleAmountCents: Math.round(Number(reservation.subtotal || 0) * 100) })
        if (result.recorded) recovered.push(result)
    }
    return recovered
}
