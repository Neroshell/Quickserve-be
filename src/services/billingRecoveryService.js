import { getStripeInvoiceSubscriptionId } from "./billingInvoiceLedgerService.js"

function stripeId(value) {
    if (typeof value === "string") return value
    if (value && typeof value.id === "string") return value.id
    return null
}

function isUnpaidOpenInvoice(invoice) {
    if (!invoice || invoice.status !== "open" || invoice.paid === true) return false
    const remaining = Number(invoice.amount_remaining)
    if (Number.isSafeInteger(remaining)) return remaining > 0
    return Number(invoice.amount_due || 0) > Number(invoice.amount_paid || 0)
}

export async function findRecoverableStripeInvoice({ stripeClient, business }) {
    if (!business?.stripeCustomerId || !stripeClient?.invoices?.list) return null

    const result = await stripeClient.invoices.list({
        customer: business.stripeCustomerId,
        status: "open",
        limit: 25,
    })
    const invoices = Array.isArray(result?.data) ? result.data : []
    return invoices.find((invoice) => {
        if (stripeId(invoice.customer) !== business.stripeCustomerId) return false
        if (!isUnpaidOpenInvoice(invoice)) return false
        if (!business.stripeSubscriptionId) return true
        return getStripeInvoiceSubscriptionId(invoice) === business.stripeSubscriptionId
    }) || null
}

export async function attemptPastDueInvoicePayment({
    stripeClient,
    business,
    paymentMethodId,
}) {
    if (business?.billingStatus !== "past_due") {
        return { attempted: false, recovered: false, pending: false, reason: "not_past_due" }
    }

    let invoice
    try {
        invoice = await findRecoverableStripeInvoice({ stripeClient, business })
    } catch (error) {
        console.error("[BillingRecovery] Open invoice lookup failed", {
            businessId: business.businessId,
            stripeSubscriptionId: business.stripeSubscriptionId || null,
            reason: error?.code || error?.name || "invoice_lookup_failed",
        })
        return { attempted: false, recovered: false, pending: false, reason: "invoice_lookup_failed" }
    }
    if (!invoice) {
        return { attempted: false, recovered: false, pending: false, reason: "no_matching_open_invoice" }
    }

    try {
        const result = await stripeClient.invoices.pay(
            invoice.id,
            paymentMethodId ? { payment_method: paymentMethodId } : undefined,
        )
        const recovered = result?.paid === true || result?.status === "paid"
        console.info("[BillingRecovery] Immediate invoice payment attempted", {
            businessId: business.businessId,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: business.stripeSubscriptionId || null,
            currency: invoice.currency || null,
            amount: invoice.amount_remaining ?? invoice.amount_due ?? null,
            recovered,
        })
        return {
            attempted: true,
            recovered,
            pending: !recovered,
            reason: recovered ? "invoice_paid" : "payment_pending",
        }
    } catch (error) {
        console.warn("[BillingRecovery] Immediate invoice payment failed", {
            businessId: business.businessId,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: business.stripeSubscriptionId || null,
            reason: error?.code || error?.name || "invoice_payment_failed",
        })
        return {
            attempted: true,
            recovered: false,
            pending: false,
            reason: "invoice_payment_failed",
        }
    }
}
