import crypto from "node:crypto"
import Stripe from "stripe"
import BillingInvoice from "../../models/BillingInvoice.js"
import Business from "../../models/Business.js"
import EmailDelivery from "../../models/EmailDelivery.js"
import Plan from "../../models/Plan.js"
import { buildEmailJobId, EMAIL_JOB_NAMES } from "../../queues/index.js"
import { EmailDeliveryError, sendEmailWithResult } from "../../utils/emailService.js"
import { formatMoneyFromMinorUnits, normalizeCurrency } from "../../utils/money.js"

const CLAIM_TTL_MS = 5 * 60 * 1000

function safeErrorCode(error) {
    return String(error?.code || error?.name || "billing_email_failed")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 200)
}

function billingDeliveryIdentity({ jobName, businessId, entityId, deliveryVersion = "1" }) {
    const normalizedVersion = String(deliveryVersion || "1")
    const deliveryId = buildEmailJobId(jobName, {
        businessId,
        deliveryId: "pending",
        entityId,
        deliveryVersion: normalizedVersion,
    })
    return { deliveryId, deliveryVersion: normalizedVersion }
}

export async function ensureBillingEmailIntent({
    jobName,
    businessId,
    entityId,
    deliveryVersion = "1",
    recipient,
    metadata = {},
    deliveryModel = EmailDelivery,
    now = new Date(),
}) {
    const identity = billingDeliveryIdentity({
        jobName,
        businessId,
        entityId,
        deliveryVersion,
    })
    const values = {
        deliveryId: identity.deliveryId,
        businessId,
        entityType: "billing",
        entityId: String(entityId),
        jobName,
        deliveryVersion: identity.deliveryVersion,
        recipient: recipient || null,
        metadata,
        status: "pending",
        retryable: true,
        enqueuedAt: null,
        enqueueError: null,
        createdAt: now,
    }
    try {
        return await deliveryModel.findOneAndUpdate(
            { deliveryId: identity.deliveryId, businessId },
            { $setOnInsert: values },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        )
    } catch (error) {
        if (error?.code !== 11000) throw error
        return deliveryModel.findOne({ deliveryId: identity.deliveryId, businessId })
    }
}

export async function markBillingEmailEnqueued({
    deliveryId,
    businessId,
    deliveryModel = EmailDelivery,
    now = new Date(),
}) {
    await deliveryModel.updateOne(
        { deliveryId, businessId, status: { $ne: "sent" } },
        { $set: { enqueuedAt: now, enqueueError: null } },
    )
}

export async function markBillingEmailEnqueueFailed({
    deliveryId,
    businessId,
    error,
    deliveryModel = EmailDelivery,
}) {
    const reason = safeErrorCode(error)
    await deliveryModel.updateOne(
        { deliveryId, businessId, status: { $ne: "sent" } },
        {
            $set: {
                status: "pending",
                enqueueError: reason,
                lastError: reason,
                retryable: true,
            },
        },
    )
}

export async function claimBillingEmailDelivery({
    deliveryId,
    businessId,
    deliveryModel = EmailDelivery,
    now = new Date(),
    claimId = crypto.randomUUID(),
}) {
    const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS)
    return deliveryModel.findOneAndUpdate(
        {
            deliveryId,
            businessId,
            entityType: "billing",
            sentAt: null,
            $or: [
                { status: { $in: ["pending", "failed"] }, retryable: { $ne: false } },
                { status: "processing", claimedAt: { $lt: staleBefore } },
            ],
        },
        {
            $set: { status: "processing", claimedAt: now, claimId, lastError: null },
            $inc: { attemptCount: 1 },
        },
        { new: true },
    )
}

async function completeBillingEmailDelivery({
    deliveryId,
    businessId,
    claimId,
    providerMessageId,
    deliveryModel,
    now,
}) {
    return deliveryModel.findOneAndUpdate(
        { deliveryId, businessId, status: "processing", claimId },
        {
            $set: {
                status: "sent",
                sentAt: now,
                providerMessageId: providerMessageId || null,
                lastError: null,
                retryable: false,
                claimedAt: null,
                claimId: null,
            },
        },
        { new: true },
    )
}

async function failBillingEmailDelivery({
    deliveryId,
    businessId,
    claimId,
    error,
    deliveryModel,
}) {
    await deliveryModel.updateOne(
        { deliveryId, businessId, status: "processing", claimId },
        {
            $set: {
                status: "failed",
                claimedAt: null,
                claimId: null,
                lastError: safeErrorCode(error),
                retryable: error?.retryable !== false,
            },
        },
    )
}

async function resolveLean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

export function resolveBillingCurrency({ stripeInvoice, stripePreview, plan, business }) {
    const candidate = stripeInvoice?.currency || stripePreview?.currency ||
        plan?.currency || business?.currency || "EUR"
    return normalizeCurrency(candidate)
}

function billingLink() {
    return `${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing`
}

async function upcomingAmountHtml({ business, plan, stripeClient }) {
    if (!business.stripeCustomerId || !stripeClient) {
        return { html: "<p>Your invoice amount will be finalized by Stripe before billing.</p>", currency: resolveBillingCurrency({ plan, business }) }
    }
    try {
        const params = { customer: business.stripeCustomerId }
        if (business.stripeSubscriptionId) params.subscription = business.stripeSubscriptionId
        const preview = await stripeClient.invoices.createPreview(params)
        const currency = resolveBillingCurrency({ stripePreview: preview, plan, business })
        if (Number.isSafeInteger(preview?.total)) {
            return {
                html: `<p>Estimated amount:<br/><strong style="font-size: 1.2em;">${formatMoneyFromMinorUnits(preview.total, currency)}</strong></p>`,
                currency,
            }
        }
    } catch (error) {
        console.warn("[BillingEmail] Invoice preview unavailable", {
            businessId: business.businessId,
            stripeSubscriptionId: business.stripeSubscriptionId || null,
            reason: error?.code || error?.name || "stripe_preview_failed",
        })
    }
    return { html: "<p>Your invoice amount will be finalized by Stripe before billing.</p>", currency: resolveBillingCurrency({ plan, business }) }
}

export async function buildBillingNotification({
    jobName,
    business,
    delivery,
    invoice,
    plan,
    stripeClient,
}) {
    const name = business.displayName || business.name || "there"
    const link = billingLink()
    if (jobName === EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE) {
        const preview = await upcomingAmountHtml({ business, plan, stripeClient })
        const invoiceDate = delivery.metadata?.invoiceDate
            ? new Date(delivery.metadata.invoiceDate)
            : null
        const formatted = invoiceDate && !Number.isNaN(invoiceDate.getTime())
            ? invoiceDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
            : "tomorrow"
        return {
            subject: "Your QuickServe invoice is coming tomorrow",
            html: `<div><p>Hi ${name},</p><p>Your next QuickServe invoice will be charged on <strong>${formatted}</strong>.</p>${preview.html}<p>This includes your subscription (if any) and offline commission fees for this billing period.</p><p><a href="${link}">Manage billing</a></p></div>`,
            currency: preview.currency,
        }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS) {
        const currency = resolveBillingCurrency({ stripeInvoice: invoice, plan, business })
        const amountMinor = Number.isSafeInteger(invoice?.amountPaid)
            ? invoice.amountPaid
            : invoice?.amountDue
        const amountText = Number.isSafeInteger(amountMinor)
            ? ` of ${formatMoneyFromMinorUnits(amountMinor, currency)}`
            : ""
        return {
            subject: "QuickServe Payment Successful",
            html: `<div><p>Hi ${name},</p><p>Your recent QuickServe payment${amountText} has been successfully processed.</p><p>Thank you for your continued partnership!</p></div>`,
            currency,
        }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3) {
        return { subject: "Action Required: QuickServe Payment Overdue", html: `<div><p>Hi ${name},</p><p>We were unable to process your recent QuickServe payment. Your account is currently <strong>overdue</strong>.</p><p>Please update your payment method to avoid service interruption.</p><p><a href="${link}">Update billing</a></p></div>` }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5) {
        return { subject: "Final Warning: QuickServe Payment Overdue", html: `<div><p>Hi ${name},</p><p>Your QuickServe account is significantly overdue. <strong>If payment is not resolved, offline services will be restricted soon.</strong></p><p><a href="${link}">Update billing</a></p></div>` }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED) {
        return { subject: "QuickServe Offline Services Restricted", html: `<div><p>Hi ${name},</p><p>Because your QuickServe payment has been overdue for 7 days, <strong>your offline ordering services have been temporarily restricted</strong>.</p><p>You can still access your dashboard and receive online-paid orders.</p><p><a href="${link}">Update billing to restore</a></p></div>` }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED) {
        return { subject: "QuickServe Services Restored", html: `<div><p>Hi ${name},</p><p>Good news! Your QuickServe billing has been resolved and <strong>your offline ordering services have been fully restored</strong>.</p><p>Thank you for your prompt attention.</p></div>` }
    }
    throw new TypeError("Unsupported billing email job")
}

const SENT_FIELD_BY_JOB = {
    [EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE]: "billingReminderSentAt",
    [EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3]: "overdueReminderSentAt",
    [EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5]: "finalWarningSentAt",
    [EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED]: "offlineRestrictionEmailSentAt",
    [EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED]: "billingRestoredEmailSentAt",
}

export async function processBillingEmailDelivery(job, {
    businessModel = Business,
    deliveryModel = EmailDelivery,
    invoiceModel = BillingInvoice,
    planModel = Plan,
    sendEmail = sendEmailWithResult,
    stripeClient,
    now = new Date(),
} = {}) {
    const { businessId, deliveryId } = job.data
    const claim = await claimBillingEmailDelivery({ deliveryId, businessId, deliveryModel, now })
    if (!claim) return { skipped: true, reason: "not_claimed" }

    try {
        const business = await resolveLean(businessModel.findOne({ businessId }))
        if (!business) throw new EmailDeliveryError("Business not found", { code: "business_not_found", retryable: false })
        const recipient = claim.recipient || business.ownerEmail || business.contactEmail
        if (!recipient) throw new EmailDeliveryError("Billing recipient missing", { code: "recipient_missing", retryable: false })

        const stripeInvoiceId = claim.metadata?.stripeInvoiceId || null
        const [invoice, plan] = await Promise.all([
            stripeInvoiceId
                ? resolveLean(invoiceModel.findOne({ businessId, stripeInvoiceId }))
                : null,
            business.currentPlan
                ? resolveLean(planModel.findOne({ slug: business.currentPlan }))
                : null,
        ])
        if (job.name === EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS && !invoice) {
            throw new EmailDeliveryError("Billing invoice ledger row not found", { code: "billing_invoice_not_found", retryable: true })
        }
        const effectiveStripeClient = stripeClient || (
            job.name === EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE &&
            process.env.STRIPE_SECRET_KEY
                ? new Stripe(process.env.STRIPE_SECRET_KEY)
                : null
        )
        const notification = await buildBillingNotification({
            jobName: job.name,
            business,
            delivery: claim,
            invoice,
            plan,
            stripeClient: effectiveStripeClient,
        })
        const result = await sendEmail({
            to: recipient,
            from: process.env.EMAIL_FROM_BILLING || "QuickServe Billing <billing@quickservehq.com>",
            subject: notification.subject,
            html: notification.html,
            idempotencyKey: deliveryId,
        })
        if (!result || result.success !== true) {
            throw new EmailDeliveryError("Provider did not accept billing email", { code: "provider_not_accepted", retryable: true })
        }

        await completeBillingEmailDelivery({
            deliveryId,
            businessId,
            claimId: claim.claimId,
            providerMessageId: result.messageId,
            deliveryModel,
            now,
        })
        const sentField = SENT_FIELD_BY_JOB[job.name]
        if (sentField) {
            const sentFields = { [sentField]: now }
            if (
                job.name === EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE &&
                claim.metadata?.invoiceDate
            ) {
                const invoiceDate = new Date(claim.metadata.invoiceDate)
                if (!Number.isNaN(invoiceDate.getTime())) {
                    sentFields.billingReminderSentForPeriod = invoiceDate
                        .toISOString()
                        .slice(0, 10)
                }
            }
            await businessModel.updateOne(
                { businessId },
                { $set: sentFields },
            ).catch(() => {})
        }
        return { success: true, messageId: result.messageId || null }
    } catch (error) {
        await failBillingEmailDelivery({
            deliveryId,
            businessId,
            claimId: claim.claimId,
            error,
            deliveryModel,
        })
        throw error
    }
}

export { safeErrorCode as safeBillingEmailErrorCode }
