import Stripe from "stripe";
import Business from "../models/Business.js";
import { sendEmail } from "../utils/emailService.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const sendBillingReminders = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const secret = process.env.CRON_SECRET;
        
        if (!secret) {
            console.error("[Cron] CRON_SECRET is not configured");
            return res.status(500).json({ error: "Server misconfiguration" });
        }
        
        if (authHeader !== `Bearer ${secret}`) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const businesses = await Business.find({
            status: "active",
            stripeSubscriptionId: { $ne: null }
        });

        let checked = 0;
        let sent = 0;
        let skipped = 0;
        let failed = 0;

        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const tomorrowString = tomorrow.toISOString().split("T")[0]; // "YYYY-MM-DD"

        for (const business of businesses) {
            checked++;
            try {
                // If we already sent a reminder for this exact period, skip
                if (business.billingReminderSentForPeriod === tomorrowString) {
                    skipped++;
                    continue;
                }

                if (!business.stripeCustomerId) {
                    skipped++;
                    continue;
                }

                // Check stripe's upcoming invoice
                let upcomingInvoice;
                try {
                    upcomingInvoice = await stripe.invoices.retrieveUpcoming({
                        customer: business.stripeCustomerId
                    });
                } catch (stripeErr) {
                    // This could be because there's no upcoming invoice (e.g. cancelled or free)
                    skipped++;
                    continue;
                }

                if (!upcomingInvoice || !upcomingInvoice.period_end) {
                    skipped++;
                    continue;
                }

                // upcomingInvoice.period_end is a unix timestamp in seconds
                const periodEndDate = new Date(upcomingInvoice.period_end * 1000);
                const periodEndString = periodEndDate.toISOString().split("T")[0];

                if (periodEndString === tomorrowString) {
                    // Send email
                    const amount = (upcomingInvoice.total / 100).toFixed(2);
                    const formattedDate = periodEndDate.toLocaleDateString("en-US", { 
                        month: "long", 
                        day: "numeric", 
                        year: "numeric", 
                        timeZone: "UTC" 
                    });

                    const emailBody = `
                        <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                            <p>Hi ${business.displayName || business.name},</p>
                            <p>Your next QuickServe invoice will be charged on <strong>${formattedDate}</strong>.</p>
                            <p>Estimated amount:<br/>
                            <strong style="font-size: 1.2em;">€${amount}</strong></p>
                            <p>This includes your subscription and offline commission fees for this billing period.</p>
                            <p style="margin-top: 25px;">
                                <a href="${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/owner/settings" style="display: inline-block; padding: 10px 20px; background-color: #EA601A; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Manage billing &rarr;</a>
                            </p>
                        </div>
                    `;

                    const emailSent = await sendEmail({
                        to: business.ownerEmail,
                        subject: "Your QuickServe invoice is coming tomorrow",
                        html: emailBody,
                        from: process.env.EMAIL_FROM || "QuickServe <no-reply@getquickserve.com>"
                    });

                    if (emailSent) {
                        business.billingReminderSentAt = new Date();
                        business.billingReminderSentForPeriod = tomorrowString;
                        await business.save();
                        sent++;
                    } else {
                        failed++;
                    }
                } else {
                    skipped++;
                }

            } catch (err) {
                console.error(`[Cron] Error processing business ${business._id}:`, err);
                failed++;
            }
        }

        return res.json({
            checked,
            sent,
            skipped,
            failed
        });
    } catch (error) {
        console.error("[Cron] Unhandled error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
