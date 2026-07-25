/**
 * test-billing-lifecycle.js
 * 
 * Tests the billing lifecycle cron endpoint locally by:
 * 1. Connecting directly to MongoDB
 * 2. Finding your real test business
 * 3. Patching its state to simulate each billing stage
 * 4. Calling the local cron endpoint
 * 5. Reporting the results
 * 6. Restoring the business to its original state
 * 
 * Usage:
 *   node scripts/test-billing-lifecycle.js [stage]
 * 
 * Stages:
 *   upcoming       - 1 day before invoice (default)
 *   overdue_day3   - 3 days past due
 *   final_day5     - 5 days past due
 *   restrict_day7  - 7 days past due (triggers restriction)
 *   restore        - Was restricted, now billing is active again
 *   guard          - Attempts to create an offline order while restricted (tests the middleware)
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const CRON_SECRET = process.env.CRON_SECRET;
const API_BASE = `http://localhost:${process.env.PORT || 5000}`;

// ─── Minimal Business model (subset of fields we need) ───────────────────────
const BusinessSchema = new mongoose.Schema({}, { strict: false, collection: "restaurants" });
const Business = mongoose.models.Business || mongoose.model("Business", BusinessSchema);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d;
}

function daysFromNow(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

async function callLifecycleCron() {
    const response = await fetch(`${API_BASE}/internal/cron/billing-lifecycle`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CRON_SECRET}`,
        },
    });

    const json = await response.json();
    console.log(`\n[Cron Response] Status: ${response.status}`);
    console.log(JSON.stringify(json, null, 2));
    return json;
}

async function callOfflineOrderGuard(businessId) {
    // We need a session cookie to test this properly.
    // This shows the 403 you'd get — check your server logs for the block.
    console.log("\n[Guard Test] Attempting offline order creation while restricted...");
    const response = await fetch(`${API_BASE}/waitstaff/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, servicePointId: "test", items: [] }),
    });
    console.log(`[Guard Test] Response: ${response.status}`);
    const text = await response.text();
    console.log(text);
}

// ─── Stage Patchers ───────────────────────────────────────────────────────────
const stages = {
    upcoming: (biz) => ({
        billingStatus: "active",
        nextInvoiceDate: daysFromNow(1),
        billingReminderSentAt: null,
        billingReminderSentForPeriod: null,
        billingFailedAt: null,
        overdueReminderSentAt: null,
        finalWarningSentAt: null,
        offlineServiceRestricted: false,
        offlineServiceRestrictedAt: null,
    }),

    overdue_day3: () => ({
        billingStatus: "past_due",
        billingFailedAt: daysAgo(3),
        overdueReminderSentAt: null,
        finalWarningSentAt: null,
        offlineServiceRestricted: false,
    }),

    final_day5: () => ({
        billingStatus: "past_due",
        billingFailedAt: daysAgo(5),
        overdueReminderSentAt: new Date(), // pretend day-3 was already sent
        finalWarningSentAt: null,
        offlineServiceRestricted: false,
    }),

    restrict_day7: () => ({
        billingStatus: "past_due",
        billingFailedAt: daysAgo(7),
        overdueReminderSentAt: new Date(),
        finalWarningSentAt: new Date(),
        offlineServiceRestricted: false,
        offlineServiceRestrictedAt: null,
        offlineRestrictionEmailSentAt: null,
    }),

    restore: () => ({
        billingStatus: "active",           // Stripe paid → billing active
        offlineServiceRestricted: true,    // But still restricted from Day 7
        offlineServiceRestrictedAt: daysAgo(2),
        billingFailedAt: daysAgo(9),
    }),
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const stage = process.argv[2] || "upcoming";

    if (stage === "guard") {
        // Special case — just call the guard without touching DB
        await callOfflineOrderGuard("test");
        process.exit(0);
    }

    if (!stages[stage]) {
        console.error(`\n❌ Unknown stage: "${stage}"`);
        console.error(`Available stages: ${Object.keys(stages).join(", ")}, guard`);
        process.exit(1);
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`🧪 Testing Billing Lifecycle — Stage: "${stage}"`);
    console.log(`${"─".repeat(60)}`);

    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Find the first business with a Stripe subscription
    const biz = await Business.findOne({ stripeSubscriptionId: { $nin: [null, ""] } });
    if (!biz) {
        console.error("❌ No business with a stripeSubscriptionId found.");
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`\n📋 Target Business: ${biz.displayName || biz.name} (${biz.businessId})`);

    // Snapshot original state
    const originalState = {
        billingStatus: biz.billingStatus,
        nextInvoiceDate: biz.nextInvoiceDate,
        billingReminderSentAt: biz.billingReminderSentAt,
        billingReminderSentForPeriod: biz.billingReminderSentForPeriod,
        billingFailedAt: biz.billingFailedAt,
        overdueReminderSentAt: biz.overdueReminderSentAt,
        finalWarningSentAt: biz.finalWarningSentAt,
        offlineServiceRestricted: biz.offlineServiceRestricted,
        offlineServiceRestrictedAt: biz.offlineServiceRestrictedAt,
        offlineRestrictionEmailSentAt: biz.offlineRestrictionEmailSentAt,
        billingRestoredAt: biz.billingRestoredAt,
        billingRestoredEmailSentAt: biz.billingRestoredEmailSentAt,
    };

    // Patch the business to simulate the target stage
    const patch = stages[stage](biz);
    console.log(`\n🔧 Patching business state to simulate stage "${stage}"...`);
    console.log(JSON.stringify(patch, null, 2));

    await Business.updateOne({ _id: biz._id }, { $set: patch });

    // Give Mongo a moment to write
    await new Promise((r) => setTimeout(r, 300));

    // Call the cron
    try {
        const result = await callLifecycleCron();

        // Check results for this business
        const myResult = result?.results?.find((r) => r.businessId === biz.businessId);
        if (myResult) {
            console.log(`\n✅ Result for ${biz.businessId}:`, JSON.stringify(myResult, null, 2));
        } else {
            console.log("\n⚠️  Business not found in cron results. It may have been silently skipped (e.g. already sent for period).");
        }

        // Verify DB state after cron run
        const after = await Business.findOne({ _id: biz._id }).lean();
        console.log(`\n📊 DB State After Cron:`);
        console.log(`  billingStatus:            ${after.billingStatus}`);
        console.log(`  offlineServiceRestricted: ${after.offlineServiceRestricted}`);
        console.log(`  offlineServiceRestrictedAt: ${after.offlineServiceRestrictedAt}`);
        console.log(`  billingFailedAt:          ${after.billingFailedAt}`);
        console.log(`  overdueReminderSentAt:    ${after.overdueReminderSentAt}`);
        console.log(`  finalWarningSentAt:       ${after.finalWarningSentAt}`);
        console.log(`  billingRestoredAt:        ${after.billingRestoredAt}`);
    } catch (err) {
        console.error("\n❌ Error calling cron endpoint:", err.message);
        console.error("  → Is the backend server running? (npm run dev)");
    } finally {
        // Restore the original state
        console.log("\n🔄 Restoring original DB state...");
        await Business.updateOne({ _id: biz._id }, { $set: originalState });
        console.log("✅ Restored.");
        await mongoose.disconnect();
        process.exit(0);
    }
}

main().catch(async (err) => {
    console.error("Fatal error:", err);
    await mongoose.disconnect();
    process.exit(1);
});

/**
 * 
 *node scripts/test-billing-lifecycle.js upcoming
node scripts/test-billing-lifecycle.js overdue_day3
node scripts/test-billing-lifecycle.js final_day5
node scripts/test-billing-lifecycle.js restrict_day7
node scripts/test-billing-lifecycle.js restore
node scripts/test-payment-success-email.js

 */