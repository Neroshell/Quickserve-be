import Stripe from "stripe";
import Business from "../models/Business.js";
import { sendEmail } from "../utils/emailService.js";
import { expireAwaitingPaymentReservations } from "../services/reservationExpiryService.js";

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
    return (
        process.env.EMAIL_FROM_BILLING || "QuickServe Billing <billing@quickservehq.com>"
    );
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

// Stage 1: Upcoming Invoices
async function sendUpcomingInvoiceReminders({ stripe, now, tomorrowString, businesses, results, summary }) {
    for (const business of businesses) {
        if (business.billingStatus !== "active") continue; // Only for active

        const result = {
            businessId: business.businessId,
            stage: "upcoming_invoice",
            reminderDate: null,
            status: "skipped",
            reason: null,
        };

        try {
            const invoiceDate = getStoredInvoiceDate(business);
            const invoiceDateString = toUtcDateString(invoiceDate);
            result.reminderDate = invoiceDateString;

            if (!invoiceDateString || business.billingReminderSentForPeriod === invoiceDateString || invoiceDateString !== tomorrowString) {
                continue; // Skip silently without logging to summary if not due
            }

            summary.checked++;
            const recipient = getBusinessRecipient(business);
            if (!recipient) {
                summary.skipped++;
                result.reason = "missing_owner_email";
                results.push(result);
                continue;
            }

            const { invoice: upcomingInvoice, error: invoiceError } = await getUpcomingInvoiceEstimate(stripe, business);
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
                    <p>This includes your subscription(if any) and offline commission fees for this billing period.</p>
                    <p style="margin-top: 25px;">
                        <a href="${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Manage billing &rarr;</a>
                    </p>
                </div>
            `;

            const emailFrom = getBillingEmailFrom();
            const emailSent = await sendEmail({
                to: recipient,
                subject: "Your QuickServe invoice is coming tomorrow",
                html: emailBody,
                from: emailFrom,
            });

            if (emailSent) {
                business.billingReminderSentAt = now;
                business.billingReminderSentForPeriod = invoiceDateString;
                await business.save();
                summary.sent++;
                result.status = "sent";
            } else {
                summary.failed++;
                result.status = "failed";
                result.reason = "email_provider_failed";
            }
            results.push(result);
        } catch (err) {
            summary.failed++;
            result.status = "failed";
            result.reason = err.message;
            results.push(result);
        }
    }
}

// Stages 2 & 3: Overdue Reminders (Day 3, Day 5)
async function processOverdueInvoices({ now, businesses, results, summary }) {
    for (const business of businesses) {
        if (business.billingStatus !== "past_due" || !business.billingFailedAt) continue;

        const daysOverdue = Math.floor((now - new Date(business.billingFailedAt)) / (1000 * 60 * 60 * 24));
        const result = {
            businessId: business.businessId,
            stage: "overdue_warning",
            status: "skipped",
            reason: null,
        };

        const recipient = getBusinessRecipient(business);
        if (!recipient) continue;

        const emailFrom = getBillingEmailFrom();

        try {
            // Day 3 Warning
            if (daysOverdue >= 3 && daysOverdue < 5 && !business.overdueReminderSentAt) {
                summary.checked++;
                const emailBody = `
                    <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                        <p>Hi ${getBusinessDisplayName(business)},</p>
                        <p>We were unable to process your recent QuickServe payment. Your account is currently <strong>overdue</strong>.</p>
                        <p>Please update your payment method to avoid service interruption.</p>
                        <p style="margin-top: 25px;">
                            <a href="${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Update billing &rarr;</a>
                        </p>
                    </div>
                `;
                const emailSent = await sendEmail({
                    to: recipient,
                    subject: "Action Required: QuickServe Payment Overdue",
                    html: emailBody,
                    from: emailFrom,
                });
                if (emailSent) {
                    business.overdueReminderSentAt = now;
                    await business.save();
                    summary.sent++;
                    result.status = "sent";
                    result.detail = "day_3";
                }
                results.push(result);
            }
            // Day 5 Final Warning
            else if (daysOverdue >= 5 && daysOverdue < 7 && !business.finalWarningSentAt) {
                summary.checked++;
                const emailBody = `
                    <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                        <p>Hi ${getBusinessDisplayName(business)},</p>
                        <p>Your QuickServe account is significantly overdue. <strong>If payment is not resolved, offline services will be restricted soon.</strong></p>
                        <p>Please update your billing information immediately.</p>
                        <p style="margin-top: 25px;">
                            <a href="${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Update billing &rarr;</a>
                        </p>
                    </div>
                `;
                const emailSent = await sendEmail({
                    to: recipient,
                    subject: "Final Warning: QuickServe Payment Overdue",
                    html: emailBody,
                    from: emailFrom,
                });
                if (emailSent) {
                    business.finalWarningSentAt = now;
                    await business.save();
                    summary.sent++;
                    result.status = "sent";
                    result.detail = "day_5";
                }
                results.push(result);
            }
        } catch (err) {
            summary.failed++;
            result.status = "failed";
            result.reason = err.message;
            results.push(result);
        }
    }
}

// Stage 4: Restrict Offline Service (Day 7)
async function processServiceRestrictions({ now, businesses, results, summary }) {
    for (const business of businesses) {
        if (business.billingStatus !== "past_due" || !business.billingFailedAt || business.offlineServiceRestricted) continue;

        const daysOverdue = Math.floor((now - new Date(business.billingFailedAt)) / (1000 * 60 * 60 * 24));
        if (daysOverdue >= 7) {
            summary.checked++;
            const result = {
                businessId: business.businessId,
                stage: "restrict_service",
                status: "skipped",
            };

            const recipient = getBusinessRecipient(business);
            
            try {
                business.offlineServiceRestricted = true;
                business.offlineServiceRestrictedAt = now;

                if (recipient) {
                    const emailBody = `
                        <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                            <p>Hi ${getBusinessDisplayName(business)},</p>
                            <p>Because your QuickServe payment has been overdue for 7 days, <strong>your offline ordering services have been temporarily restricted</strong>.</p>
                            <p>You can still access your dashboard and receive online-paid orders, but your staff can no longer create offline orders until the balance is settled.</p>
                            <p style="margin-top: 25px;">
                                <a href="${process.env.FRONTEND_BASE_URL || "http://localhost:3000"}/owner/billing" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Update billing to restore &rarr;</a>
                            </p>
                        </div>
                    `;
                    const emailSent = await sendEmail({
                        to: recipient,
                        subject: "QuickServe Offline Services Restricted",
                        html: emailBody,
                        from: getBillingEmailFrom(),
                    });
                    if (emailSent) {
                        business.offlineRestrictionEmailSentAt = now;
                    }
                }
                
                await business.save();
                summary.restricted++;
                result.status = "restricted";
                results.push(result);
            } catch (err) {
                summary.failed++;
                result.status = "failed";
                result.reason = err.message;
                results.push(result);
            }
        }
    }
}

// Stage 5: Restore Offline Service
async function processServiceRestorations({ now, businesses, results, summary }) {
    for (const business of businesses) {
        // If they are active but currently restricted, we must restore them
        if (business.billingStatus === "active" && business.offlineServiceRestricted) {
            summary.checked++;
            const result = {
                businessId: business.businessId,
                stage: "restore_service",
                status: "skipped",
            };

            try {
                business.offlineServiceRestricted = false;
                business.offlineServiceRestrictedAt = null;
                business.offlineRestrictionEmailSentAt = null;
                business.overdueReminderSentAt = null;
                business.finalWarningSentAt = null;
                business.billingFailedAt = null;
                business.billingRestoredAt = now;

                const recipient = getBusinessRecipient(business);
                if (recipient) {
                    const emailBody = `
                        <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                            <p>Hi ${getBusinessDisplayName(business)},</p>
                            <p>Good news! Your QuickServe billing has been resolved and <strong>your offline ordering services have been fully restored</strong>.</p>
                            <p>Thank you for your prompt attention.</p>
                        </div>
                    `;
                    const emailSent = await sendEmail({
                        to: recipient,
                        subject: "QuickServe Services Restored",
                        html: emailBody,
                        from: getBillingEmailFrom(),
                    });
                    if (emailSent) {
                        business.billingRestoredEmailSentAt = now;
                    }
                }

                await business.save();
                summary.restored++;
                result.status = "restored";
                results.push(result);
            } catch (err) {
                summary.failed++;
                result.status = "failed";
                result.reason = err.message;
                results.push(result);
            }
        }
    }
}

export const processBillingLifecycle = async (req, res) => {
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
            billingStatus: { $in: ["active", "past_due"] },
            stripeSubscriptionId: { $nin: [null, ""] },
            status: { $nin: ["archived", "suspended"] },
        });

        const now = new Date();
        const tomorrowString = toUtcDateString(addUtcDays(now, 1));
        
        const summary = {
            checked: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
            restricted: 0,
            restored: 0,
        };
        const results = [];

        await sendUpcomingInvoiceReminders({ stripe, now, tomorrowString, businesses, results, summary });
        await processOverdueInvoices({ now, businesses, results, summary });
        await processServiceRestrictions({ now, businesses, results, summary });
        await processServiceRestorations({ now, businesses, results, summary });

        return res.json({
            tomorrow: tomorrowString,
            summary,
            results,
        });
    } catch (error) {
        console.error("[Cron] Unhandled error in billing lifecycle:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const processReservationExpiry = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const secret = process.env.CRON_SECRET;

        if (!secret) {
            return res.status(500).json({ error: "Server misconfiguration" });
        }

        if (authHeader !== `Bearer ${secret}`) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const now = new Date();
        const result = await expireAwaitingPaymentReservations({
            now,
            allTenants: true,
        });

        return res.json({
            message: "Reservation expiry processed",
            expiredCount: result.modifiedCount
        });
    } catch (error) {
        console.error("[Cron] Unhandled error in reservation expiry:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
