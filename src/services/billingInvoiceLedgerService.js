import BillingInvoice from "../models/BillingInvoice.js"

function stripeId(value) {
    if (typeof value === "string") return value
    if (value && typeof value.id === "string") return value.id
    return null
}

export function getStripeInvoiceSubscriptionId(invoice) {
    return stripeId(invoice?.subscription) ||
        stripeId(invoice?.parent?.subscription_details?.subscription)
}

export function getStripeInvoiceCustomerId(invoice) {
    return stripeId(invoice?.customer)
}

function stripeTimestamp(value) {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return new Date(seconds * 1000)
}

function integerMinorUnits(value) {
    const amount = Number(value)
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
}

function invoiceTaxMinorUnits(invoice) {
    if (Number.isSafeInteger(Number(invoice?.tax)) && Number(invoice.tax) >= 0) {
        return Number(invoice.tax)
    }
    const amounts = Array.isArray(invoice?.total_tax_amounts)
        ? invoice.total_tax_amounts
        : []
    return amounts.reduce((sum, item) => sum + integerMinorUnits(item?.amount), 0)
}

function ledgerStatus(invoice, eventType) {
    if (eventType === "invoice.paid" || invoice?.paid === true || invoice?.status === "paid") {
        return "paid"
    }
    if (eventType === "invoice.payment_failed") return "failed"
    const supported = new Set(["draft", "open", "void", "uncollectible"])
    return supported.has(invoice?.status) ? invoice.status : "open"
}

export function mapStripeInvoiceToLedger({ businessId, invoice, eventType }) {
    if (!businessId) throw new TypeError("businessId is required")
    if (!invoice?.id) throw new TypeError("Stripe invoice ID is required")

    const periodStart = stripeTimestamp(invoice.period_start)
    const periodEnd = stripeTimestamp(invoice.period_end)
    const amountDue = integerMinorUnits(invoice.amount_due ?? invoice.total)
    const amountPaid = integerMinorUnits(invoice.amount_paid)
    const status = ledgerStatus(invoice, eventType)
    const currency = String(invoice.currency || "").trim().toUpperCase() || null

    return {
        businessId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: getStripeInvoiceSubscriptionId(invoice),
        stripeCustomerId: getStripeInvoiceCustomerId(invoice),
        status,
        currency,
        amount: amountDue,
        amountDue,
        amountPaid,
        subtotal: integerMinorUnits(invoice.subtotal),
        tax: invoiceTaxMinorUnits(invoice),
        commission: 0,
        commissionRateUsed: 0,
        billingPeriod: periodStart && periodEnd
            ? `${periodStart.toISOString()}/${periodEnd.toISOString()}`
            : `stripe-invoice-${invoice.id}`,
        periodStart,
        periodEnd,
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
        invoicePdf: invoice.invoice_pdf || null,
        stripeCreatedAt: stripeTimestamp(invoice.created),
        paidAt: status === "paid"
            ? stripeTimestamp(invoice.status_transitions?.paid_at) || new Date()
            : null,
    }
}

async function resolveLean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

export async function upsertBillingInvoiceFromStripe({
    businessId,
    invoice,
    eventType,
    invoiceModel = BillingInvoice,
}) {
    const values = mapStripeInvoiceToLedger({ businessId, invoice, eventType })
    const existing = await resolveLean(invoiceModel.findOne({
        stripeInvoiceId: values.stripeInvoiceId,
    }))
    if (existing && existing.businessId !== businessId) {
        const error = new Error("Stripe invoice is already assigned to another business")
        error.code = "BILLING_INVOICE_TENANT_CONFLICT"
        throw error
    }
    if (existing?.status === "paid" && values.status !== "paid") return existing

    return invoiceModel.findOneAndUpdate(
        { businessId, stripeInvoiceId: values.stripeInvoiceId },
        { $set: values },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    )
}

export async function listBillingInvoicesForBusiness({
    businessId,
    invoiceModel = BillingInvoice,
    stripeClient,
}) {
    if (!businessId) throw new TypeError("businessId is required")
    const query = invoiceModel.find({ businessId })
        .sort({ stripeCreatedAt: -1, createdAt: -1 })
    const rows = await resolveLean(query)

    return Promise.all(rows.map(async (invoice) => {
        let hostedInvoiceUrl = invoice.hostedInvoiceUrl || invoice.hosted_invoice_url || null
        let invoicePdf = invoice.invoicePdf || invoice.invoice_pdf || null
        if (
            invoice.stripeInvoiceId &&
            !hostedInvoiceUrl &&
            !invoicePdf &&
            stripeClient?.invoices?.retrieve
        ) {
            try {
                const stripeInvoice = await stripeClient.invoices.retrieve(invoice.stripeInvoiceId)
                hostedInvoiceUrl = stripeInvoice.hosted_invoice_url || null
                invoicePdf = stripeInvoice.invoice_pdf || null
            } catch (error) {
                console.error("[BillingInvoiceLedger] Legacy Stripe invoice fallback failed", {
                    businessId,
                    stripeInvoiceId: invoice.stripeInvoiceId,
                    reason: error?.code || error?.name || "stripe_invoice_lookup_failed",
                })
            }
        }
        return {
            ...invoice,
            hostedInvoiceUrl,
            invoicePdf,
            hosted_invoice_url: hostedInvoiceUrl,
            invoice_pdf: invoicePdf,
        }
    }))
}
