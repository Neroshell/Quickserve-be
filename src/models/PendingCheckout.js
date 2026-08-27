import mongoose from "mongoose"
import { getPendingCheckoutExpiresAt } from "../constants/checkoutRetention.js"

/**
 * Temporary storage for cart data while the customer is completing
 * Stripe Checkout. Once payment is confirmed via webhook, the data
 * here is used to create the real Order, and this document is deleted.
 *
 * Auto-expires only after Stripe's payment and webhook-delivery windows close.
 */

const PendingItemSchema = new mongoose.Schema(
    {
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
        itemName: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        lineTotal: { type: Number, required: true },
        prepTimeMinutes: { type: Number, default: null },
        category: { type: String, default: "mains" },
        type: { type: String, enum: ["food", "drinks"], default: "food" },
        notes: { type: String, default: "" },
        allergies: { type: [String], default: [] },
    },
    { _id: false }
)

const PendingCheckoutSchema = new mongoose.Schema(
    {
        businessId: { type: String, required: true },
        orderId: { type: String, required: true },
        servicePointLabel: { type: String, required: true }, // internal servicePointId â€” e.g. sp_xxxx
        displayLabel: { type: String, default: "" },      // human-friendly â€” e.g. "Table 10"
        orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in" },
        sessionId: { type: String, required: true },
        journeyId: { type: String, default: null },
        items: { type: [PendingItemSchema], required: true },
        subtotal: { type: Number, default: 0 },
        taxAmount: { type: Number, default: 0 },
        tipAmount: { type: Number, default: 0 },
        tipType: { type: String, enum: ["percentage", "custom", null], default: null },
        tipPercentage: { type: Number, default: null },
        total: { type: Number, default: 0 },
        currency: { type: String, default: "EUR" },
        receiptEmail: { type: String, default: null },

        // Stripe reference
        stripeSessionId: { type: String, default: null },
        stripeExpiresAt: { type: Date, default: null },

        // Stripe Connect split metadata â€” populated at checkout session creation
        stripePaymentIntentId: { type: String, default: null },
        stripeConnectedAccountId: { type: String, default: null },
        grossAmount: { type: Number, default: null }, // cents
        netToBusinessAmount: { type: Number, default: null }, // cents

        // Commission locking â€” rate is frozen at checkout creation
        planApplied: { type: String, default: null },
        commissionRateApplied: { type: Number, default: null },   // e.g. 2.5 (percentage)
        commissionAmountCents: { type: Number, default: 0 },      // pre-calculated commission in cents
        planAtOrder: { type: String, default: null },
        commissionRateAtOrder: { type: Number, default: null },
        platformFeeRateAtOrder: { type: Number, default: null },

        // Platform Fee Split details
        platformFeeCents: { type: Number, default: 0 },
        customerPlatformFeeCents: { type: Number, default: 0 },
        businessAbsorbedPlatformFeeCents: { type: Number, default: 0 },
        platformFeeMode: { type: String, enum: ["business_absorbs", "customer_pays", "split"], default: "business_absorbs" },
        customerPlatformFeePercent: { type: Number, default: 0 },

        // The controller re-anchors this to Stripe's returned expires_at after
        // Session creation. This default safely covers the same maximum window.
        expiresAt: {
            type: Date,
            default: () => getPendingCheckoutExpiresAt(),
        },
    },
    { timestamps: true }
)

PendingCheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.models.PendingCheckout || mongoose.model("PendingCheckout", PendingCheckoutSchema)
