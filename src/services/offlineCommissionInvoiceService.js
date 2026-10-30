import CommissionAccrual from "../models/CommissionAccrual.js"
import CommissionInvoiceBatch from "../models/CommissionInvoiceBatch.js"
import CommissionAdjustment from "../models/CommissionAdjustment.js"

function stripeId(value) { return typeof value === "string" ? value : value?.id || null }

export async function verifyCommissionBillingAuthorisation({ business, stripeClient }) {
    if (!business?.stripeCustomerId || !business?.defaultPaymentMethodId) return { valid: false, reason: "missing_customer_or_payment_method" }
    if (!stripeClient?.customers?.retrieve || !stripeClient?.paymentMethods?.retrieve) return { valid: false, reason: "stripe_client_unavailable" }
    const [customer, method] = await Promise.all([
        stripeClient.customers.retrieve(business.stripeCustomerId),
        stripeClient.paymentMethods.retrieve(business.defaultPaymentMethodId),
    ])
    if (customer?.deleted || stripeId(method?.customer) !== business.stripeCustomerId) return { valid: false, reason: "payment_method_customer_mismatch" }
    if (stripeId(customer?.invoice_settings?.default_payment_method) !== business.defaultPaymentMethodId) return { valid: false, reason: "customer_default_payment_method_mismatch" }
    return { valid: true, customer, method }
}

export async function claimCommissionInvoiceBatch({ businessId, billingPeriod, currency }) {
    const batch = await CommissionInvoiceBatch.findOne({ businessId, billingPeriod, currency })
    if (batch) return { claimed: false, batch }
    const accruals = await CommissionAccrual.find({ businessId, billingPeriod, currency, status: "pending" }).sort({ createdAt: 1 }).lean()
    if (!accruals.length) return { claimed: false, reason: "no_pending_accruals" }
    const idempotencyKey = `offline-commission:${businessId}:${billingPeriod}:${currency}`
    let created
    try {
        created = await CommissionInvoiceBatch.create({
            businessId, billingPeriod, currency, idempotencyKey,
            accrualCount: accruals.length,
            amountCents: accruals.reduce((total, item) => total + item.commissionAmountCents, 0),
        })
    } catch (error) {
        if (error?.code === 11000) return { claimed: false, batch: await CommissionInvoiceBatch.findOne({ businessId, billingPeriod, currency }) }
        throw error
    }
    const result = await CommissionAccrual.updateMany(
        { _id: { $in: accruals.map((item) => item._id) }, businessId, status: "pending" },
        { $set: { status: "claimed", invoiceBatchId: created._id } },
    )
    if (result.modifiedCount !== accruals.length) {
        await CommissionInvoiceBatch.findByIdAndUpdate(created._id, { $set: { status: "held", holdReason: "concurrent_accrual_claim" } })
        return { claimed: false, batch: await CommissionInvoiceBatch.findById(created._id), reason: "concurrent_accrual_claim" }
    }
    return { claimed: true, batch: created, accruals }
}

export async function createStripeCommissionInvoice({ batchId, business, stripeClient, env = process.env }) {
    // No caller-controlled boolean can authorise a financial action. Activation
    // requires both the audited tenant cutover and independent worker config.
    if (env.CHILLOW_OFFLINE_COMMISSION_COLLECTION_ENABLED !== "true") return { created: false, reason: "collection_feature_disabled" }
    if (!business?.offlineCommissionInvoiceEnabled || !business?.offlineCommissionInvoiceCutoverAt) return { created: false, reason: "business_cutover_not_enabled" }
    const batch = await CommissionInvoiceBatch.findOne({ _id: batchId, businessId: business.businessId })
    if (!batch) throw new Error("Commission invoice batch not found")
    if (batch.stripeInvoiceId) return { created: false, reason: "already_has_stripe_invoice", batch }
    if (batch.status !== "claimed") return { created: false, reason: "batch_not_claimed", batch }
    if (String(batch.currency).toUpperCase() !== String(business.currency).toUpperCase()) return { created: false, reason: "batch_currency_mismatch" }
    const authorisation = await verifyCommissionBillingAuthorisation({ business, stripeClient })
    if (!authorisation.valid) {
        await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status: "held", holdReason: authorisation.reason } })
        return { created: false, reason: authorisation.reason }
    }
    const accruals = await CommissionAccrual.find({ businessId: business.businessId, invoiceBatchId: batch._id, status: "claimed", commissionReportedToStripe: { $ne: true } }).lean()
    const amount = accruals.reduce((sum, item) => sum + item.commissionAmountCents, 0)
    if (!accruals.length || amount !== batch.amountCents || amount <= 0) {
        await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status: "held", holdReason: "accrual_total_mismatch" } })
        return { created: false, reason: "accrual_total_mismatch" }
    }
    try {
        // Explicit invoice association prevents this item joining a subscription invoice.
        const invoice = await stripeClient.invoices.create({ customer: business.stripeCustomerId, currency: batch.currency.toLowerCase(), collection_method: "charge_automatically", default_payment_method: business.defaultPaymentMethodId, auto_advance: false, pending_invoice_items_behavior: "exclude", metadata: { chillow_invoice_type: "offline_commission", commission_batch_id: String(batch._id), businessId: business.businessId } }, { idempotencyKey: `${batch.idempotencyKey}:invoice` })
        const item = await stripeClient.invoiceItems.create({ customer: business.stripeCustomerId, invoice: invoice.id, currency: batch.currency.toLowerCase(), amount, description: `Chillow offline commission ${batch.billingPeriod}`, metadata: { commission_batch_id: String(batch._id), businessId: business.businessId } }, { idempotencyKey: `${batch.idempotencyKey}:item` })
        await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status: "draft", stripeInvoiceId: invoice.id, stripeInvoiceItemId: item.id, stripeCustomerId: business.stripeCustomerId, collectionMethod: "charge_automatically" } })
        const finalized = await stripeClient.invoices.finalizeInvoice(invoice.id, { auto_advance: true }, { idempotencyKey: `${batch.idempotencyKey}:finalize` })
        await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status: "finalized", finalizedAt: new Date(), stripeInvoiceId: finalized.id } })
        await CommissionAccrual.updateMany({ businessId: business.businessId, invoiceBatchId: batch._id, status: "claimed" }, { $set: { status: "invoiced", stripeInvoiceId: finalized.id } })
        return { created: true, invoice: finalized }
    } catch (error) {
        // Do not retry an uncertain remote operation. A human/test-mode
        // reconciliation must first attach the provider identity to this batch.
        await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status: "held", holdReason: `stripe_${error?.type || error?.code || "unknown"}` } })
        throw error
    }
}

export async function reconcileCommissionInvoiceEvent({ businessId, invoice, eventType }) {
    const batchId = invoice?.metadata?.commission_batch_id
    if (!batchId || invoice?.metadata?.chillow_invoice_type !== "offline_commission") return null
    const batch = await CommissionInvoiceBatch.findOne({ _id: batchId, businessId, stripeInvoiceId: invoice.id })
    if (!batch) return null
    const status = eventType === "invoice.paid" ? "paid" : eventType === "invoice.payment_failed" ? "failed" : eventType === "invoice.voided" ? "void" : "finalized"
    await CommissionInvoiceBatch.findByIdAndUpdate(batch._id, { $set: { status, paidAt: status === "paid" ? new Date() : null, failedAt: status === "failed" ? new Date() : null } })
    return CommissionAccrual.updateMany({ businessId, invoiceBatchId: batch._id }, { $set: { status: status === "paid" ? "invoiced" : "held" } })
}

export async function recordCommissionRefundAdjustment({ businessId, accrual, sourceRefundId, refundedEligibleAmountCents }) {
    if (!accrual || accrual.businessId !== businessId) throw new Error("Accrual tenant mismatch")
    const original = Number(accrual.eligibleAmountCents)
    const refunded = Math.max(0, Math.min(original, Number(refundedEligibleAmountCents || 0)))
    const amountCents = Math.round(Number(accrual.commissionAmountCents) * (refunded / original))
    if (!amountCents) return { recorded: false, reason: "no_commission_adjustment" }
    const status = accrual.status === "invoiced" ? "credit_required" : "pending"
    const adjustment = await CommissionAdjustment.findOneAndUpdate({ businessId, accrualId: accrual._id, sourceRefundId }, { $setOnInsert: { businessId, accrualId: accrual._id, sourceRefundId, amountCents, status } }, { upsert: true, new: true, setDefaultsOnInsert: true })
    return { recorded: true, adjustment }
}
