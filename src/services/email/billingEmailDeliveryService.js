import crypto from "node:crypto"
import { getCanonicalFrontendOrigin } from "../../config/frontendUrl.js";
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
    return `${getCanonicalFrontendOrigin()}/owner/billing`
}

function escapeEmailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/**
 * Billing messages are intentionally self-contained HTML because this delivery
 * path must remain usable without changing its durable queue contract. The
 * presentation uses tables and inline styles for broad email-client support.
 */
function renderBillingEmail({ title, preview = "", status, tone = "info", greeting, paragraphs = [], detailHtml = "", action = null, footer = "" }) {
    const tones = {
        info: { foreground: "#1d4ed8", background: "#eff6ff", border: "#bfdbfe" },
        success: { foreground: "#166534", background: "#f0fdf4", border: "#bbf7d0" },
        warning: { foreground: "#92400e", background: "#fffbeb", border: "#fde68a" },
        danger: { foreground: "#b91c1c", background: "#fef2f2", border: "#fecaca" },
    }
    const palette = tones[tone] || tones.info
    const copy = paragraphs.map((paragraph) => `<p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:24px;">${escapeEmailHtml(paragraph)}</p>`).join("")
    const actionHtml = action?.href && action?.label
        ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:28px auto 0;"><tr><td align="center" bgcolor="#c2410c" style="border-radius:8px;"><a href="${escapeEmailHtml(action.href)}" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${escapeEmailHtml(action.label)}</a></td></tr></table>`
        : ""
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0;padding:0;background:#f6f9fc;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeEmailHtml(preview)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;"><tr><td style="border-top:4px solid #ea601a;padding:20px 32px 18px;text-align:center;"><p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Chillow</p><h1 style="margin:0;color:#0f172a;font-size:26px;line-height:34px;">${escapeEmailHtml(title)}</h1></td></tr><tr><td style="padding:0 32px 32px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;background:${palette.background};border:1px solid ${palette.border};border-radius:8px;"><tr><td style="padding:12px 16px;color:${palette.foreground};font-size:14px;font-weight:700;">${escapeEmailHtml(status)}</td></tr></table><p style="margin:0 0 16px;color:#0f172a;font-size:16px;font-weight:700;line-height:24px;">Hi ${escapeEmailHtml(greeting || "there")},</p>${copy}${detailHtml}${actionHtml}${footer ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:20px;">${escapeEmailHtml(footer)}</p>` : ""}</td></tr><tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;color:#64748b;font-size:13px;">Chillow billing</td></tr></table></td></tr></table></body></html>`
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
            subject: "Your Chillow invoice is coming up",
            html: renderBillingEmail({
                title: "Your next invoice is coming up",
                preview: `Estimated charge available for ${formatted}.`,
                status: "Upcoming invoice",
                greeting: name,
                paragraphs: [`Your next Chillow invoice is scheduled for ${formatted}.`, "Charges can include your subscription and applicable offline commissions."],
                detailHtml: `<div style="margin:0 0 8px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:15px;line-height:24px;">${preview.html}</div>`,
                action: { href: link, label: "Manage billing" },
            }),
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
            subject: "Your Chillow payment was successful",
            html: renderBillingEmail({
                title: "Payment successful",
                preview: `Your Chillow payment${amountText} was processed successfully.`,
                status: "Paid",
                tone: "success",
                greeting: name,
                paragraphs: [`Your Chillow payment${amountText} has been processed successfully.`, "Thank you for continuing to operate with Chillow."],
            }),
            currency,
        }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3) {
        return { subject: "Action needed: Chillow payment overdue", html: renderBillingEmail({ title: "Your payment is overdue", preview: "Update your payment method to help avoid interruption.", status: "Payment overdue", tone: "warning", greeting: name, paragraphs: ["We could not complete your Chillow payment. Update your payment method to help avoid interruption to offline ordering services."], action: { href: link, label: "Review billing" } }) }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5) {
        return { subject: "Final reminder: Chillow payment overdue", html: renderBillingEmail({ title: "Final payment reminder", preview: "Offline ordering may be restricted if payment remains unresolved.", status: "Final reminder", tone: "danger", greeting: name, paragraphs: ["Your Chillow payment is still overdue. If it is not resolved, offline ordering services may soon be restricted."], action: { href: link, label: "Review billing" } }) }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED) {
        return { subject: "Chillow offline ordering is restricted", html: renderBillingEmail({ title: "Offline ordering is restricted", preview: "Dashboard access and online-paid orders remain available.", status: "Offline ordering restricted", tone: "danger", greeting: name, paragraphs: ["Your Chillow payment has been overdue for seven days, so offline ordering services are temporarily restricted.", "You can still access your dashboard and receive online-paid orders. Resolve the billing issue to restore offline ordering."], action: { href: link, label: "Review billing" } }) }
    }
    if (jobName === EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED) {
        return { subject: "Chillow offline ordering has been restored", html: renderBillingEmail({ title: "Offline ordering is available again", preview: "Your offline ordering services are available again.", status: "Services restored", tone: "success", greeting: name, paragraphs: ["Your Chillow billing issue has been resolved. Offline ordering services have been restored.", "You can continue using supported offline ordering workflows."] }) }
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
