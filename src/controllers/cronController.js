import Stripe from "stripe";
import Business from "../models/Business.js";
import { sendEmail } from "../utils/emailService.js";

function toUtcDateString(date) {
    if (!date) return null;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().split("T")[0];
}

function addUtcDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function getStoredInvoiceDate(business) {
    if (business.nextInvoiceDate) return new Date(business.nextInvoiceDate);
    if (business.nextBillingDate) return new Date(business.nextBillingDate);
    if (business.currentPeriodEnd) {
        const periodEnd = new Date(business.currentPeriodEnd);
        if (!Number.isNaN(periodEnd.getTime())) {
            return new Date(periodEnd.getTime() + 1);
        }
    }
    return null;
}

function getBusinessRecipient(business) {
    return business.ownerEmail || business.contactEmail || null;
}

function getBusinessDisplayName(business) {
    return business.displayName || business.name || "there";
}

function getBillingEmailFrom() {
    return process.env.EMAIL_FROM_BILLING ||
        process.env.EMAIL_FROM_AUTH ||
        process.env.EMAIL_FROM_ONBOARDING ||
        process.env.EMAIL_FROM_RECEIPTS ||
        process.env.EMAIL_FROM ||
        "QuickServe <onboarding@quickservehq.com>";
}

async function getUpcomingInvoiceEstimate(stripe, business) {
    if (!business.stripeCustomerId) {
        return { invoice: null, error: "missing_stripe_customer" };
    }

    try {
        const previewParams = { customer: business.stripeCustomerId };
        if (business.stripeSubscriptionId) {
            previewParams.subscription = business.stripeSubscriptionId;
        }

        const invoice = await stripe.invoices.createPreview(previewParams);
        return { invoice, error: null };
    } catch (error) {
        return { invoice: null, error: error.message || "stripe_upcoming_invoice_unavailable" };
    }
}

export const sendBillingReminders = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const secret = process.env.CRON_SECRET;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        if (!secret) {
            console.error("[Cron] CRON_SECRET is not configured");
            return res.status(500).json({ error: "Server misconfiguration" });
        }

        if (authHeader !== `Bearer ${secret}`) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const businesses = await Business.find({
            billingStatus: "active",
            stripeSubscriptionId: { $nin: [null, ""] },
            status: { $nin: ["archived", "suspended"] },
        });

        let checked = 0;
        let sent = 0;
        let skipped = 0;
        let failed = 0;
        const results = [];

        const now = new Date();
        const tomorrowString = toUtcDateString(addUtcDays(now, 1));

        for (const business of businesses) {
            checked++;
            const result = {
                businessId: business.businessId,
                reminderDate: null,
                recipient: Boolean(getBusinessRecipient(business)),
                status: "skipped",
                reason: null,
            };

            try {
                const invoiceDate = getStoredInvoiceDate(business);
                const invoiceDateString = toUtcDateString(invoiceDate);
                result.reminderDate = invoiceDateString;

                if (!invoiceDateString) {
                    skipped++;
                    result.reason = "missing_next_invoice_date";
                    results.push(result);
                    continue;
                }

                if (business.billingReminderSentForPeriod === invoiceDateString) {
                    skipped++;
                    result.reason = "already_sent_for_period";
                    results.push(result);
                    continue;
                }

                if (invoiceDateString !== tomorrowString) {
                    skipped++;
                    result.reason = "not_due_tomorrow";
                    results.push(result);
                    continue;
                }

                const recipient = getBusinessRecipient(business);
                if (!recipient) {
                    skipped++;
                    result.reason = "missing_owner_email";
                    results.push(result);
                    continue;
                }

                const { invoice: upcomingInvoice, error: invoiceError } = await getUpcomingInvoiceEstimate(stripe, business);
                if (invoiceError) {
                    result.stripeInvoiceWarning = invoiceError;
                }

                if (upcomingInvoice?.period_end) {
                    result.stripeUpcomingDate = toUtcDateString(new Date(upcomingInvoice.period_end * 1000));
                }

                const formattedDate = invoiceDate.toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC",
                });

                const hasAmount = typeof upcomingInvoice?.total === "number";
                const amount = hasAmount ? (upcomingInvoice.total / 100).toFixed(2) : null;
                const amountHtml = hasAmount
                    ? `<p>Estimated amount:<br/><strong style="font-size: 1.2em;">&euro;${amount}</strong></p>`
                    : `<p>Your invoice amount will be finalized by Stripe before billing.</p>`;

                const emailBody = `
                    <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                        <p>Hi ${getBusinessDisplayName(business)},</p>
                        <p>Your next QuickServe invoice will be charged on <strong>${formattedDate}</strong>.</p>
                        ${amountHtml}
                        <p>This includes your subscription and offline commission fees for this billing period.</p>
                        <p style="margin-top: 25px;">
                            <a href="${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Manage billing &rarr;</a>
                        </p>
                    </div>
                `;

                const emailFrom = getBillingEmailFrom();
                result.emailFrom = emailFrom;

                const emailSent = await sendEmail({
                    to: recipient,
                    subject: "Your QuickServe invoice is coming tomorrow",
                    html: emailBody,
                    from: emailFrom,
                });

                if (emailSent) {
                    business.billingReminderSentAt = new Date();
                    business.billingReminderSentForPeriod = invoiceDateString;
                    await business.save();
                    sent++;
                    result.status = "sent";
                    result.reason = null;
                } else {
                    failed++;
                    result.status = "failed";
                    result.reason = "email_provider_failed";
                }

                results.push(result);
            } catch (err) {
                console.error(`[Cron] Error processing business ${business._id}:`, err);
                failed++;
                result.status = "failed";
                result.reason = err.message || "processing_error";
                results.push(result);
            }
        }

        return res.json({
            checked,
            sent,
            skipped,
            failed,
            tomorrow: tomorrowString,
            results,
        });
    } catch (error) {
        console.error("[Cron] Unhandled error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
