/**
 * test-payment-success-email.js
 * 
 * Directly tests the Option B (Payment Success) email template and transmission
 * using the real business details, Resend API key, and SMTP config from your .env file.
 * 
 * Usage:
 *   node scripts/test-payment-success-email.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { sendEmail } from "../src/utils/emailService.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ─── Minimal Business model ──────────────────────────────────────────────────
const BusinessSchema = new mongoose.Schema({}, { strict: false, collection: "restaurants" });
const Business = mongoose.models.Business || mongoose.model("Business", BusinessSchema);

async function main() {
    console.log("🧪 Testing Option B (Payment Success Email)...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Find the test business
    const biz = await Business.findOne({ stripeSubscriptionId: { $nin: [null, ""] } });
    if (!biz) {
        console.error("❌ No business with a stripeSubscriptionId found.");
        await mongoose.disconnect();
        process.exit(1);
    }

    const recipient = biz.ownerEmail || biz.contactEmail || null;
    if (!recipient) {
        console.error(`❌ Business "${biz.name}" is missing both ownerEmail and contactEmail.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    const displayName = biz.displayName || biz.name || "there";
    const amountVal = "49.00"; // Test mock amount
    
    console.log(`\n📋 Target Business: ${biz.name} (${biz.businessId})`);
    console.log(`✉️ Sending to: ${recipient}`);

    const emailBody = `
        <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
            <p>Hi ${displayName},</p>
            <p>Your recent QuickServe payment of €${amountVal} has been successfully processed.</p>
            <p>Thank you for your continued partnership!</p>
        </div>
    `;

    const from = process.env.EMAIL_FROM_BILLING || "QuickServe Billing <billing@quickservehq.com>";
    
    console.log(`📤 Dispatching email from: ${from}...`);

    try {
        const emailSent = await sendEmail({
            to: recipient,
            subject: "QuickServe Payment Successful",
            html: emailBody,
            from,
        });

        if (emailSent) {
            console.log("\n🎉 Success! The payment success email was sent successfully.");
            console.log("Check your inbox shortly.");
        } else {
            console.error("\n❌ Failed to send email. Check your Resend API key and logs.");
        }
    } catch (err) {
        console.error("\n❌ Error sending email:", err);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

main().catch(async (err) => {
    console.error("Fatal error:", err);
    await mongoose.disconnect();
    process.exit(1);
});
