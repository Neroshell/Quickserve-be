import mongoose from "mongoose"

/**
 * Temporary storage for cart data while the customer is completing
 * Stripe Checkout. Once payment is confirmed via webhook, the data
 * here is used to create the real Order, and this document is deleted.
 *
 * Auto-expires after 1 hour (TTL index) for abandoned checkouts.
 */

const PendingItemSchema = new mongoose.Schema(
    {
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
        itemName: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        lineTotal: { type: Number, required: true },
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
        tableNumber: { type: String, required: true }, // internal servicePointId — e.g. sp_xxxx
        tableLabel: { type: String, default: "" },      // human-friendly — e.g. "Table 10"
        orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in" },
        sessionId: { type: String, required: true },
        items: { type: [PendingItemSchema], required: true },
        subtotal: { type: Number, default: 0 },
        taxAmount: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        currency: { type: String, default: "EUR" },
        receiptEmail: { type: String, default: null },

        // Stripe reference
        stripeSessionId: { type: String, default: null },

        // Stripe Connect split metadata — populated at checkout session creation
        stripePaymentIntentId:    { type: String, default: null },
        stripeConnectedAccountId: { type: String, default: null },
        grossAmount:              { type: Number, default: null }, // cents
        netToBusinessAmount:      { type: Number, default: null }, // cents

        // Commission locking — rate is frozen at checkout creation
        planApplied:             { type: String, default: null },
        commissionRateApplied:   { type: Number, default: null },   // e.g. 2.5 (percentage)
        commissionAmountCents:   { type: Number, default: 0 },      // pre-calculated commission in cents

        // Platform Fee Split details
        platformFeeCents: { type: Number, default: 0 },
        customerPlatformFeeCents: { type: Number, default: 0 },
        businessAbsorbedPlatformFeeCents: { type: Number, default: 0 },
        platformFeeMode: { type: String, enum: ["business_absorbs", "customer_pays", "split"], default: "business_absorbs" },
        customerPlatformFeePercent: { type: Number, default: 0 },

        // TTL: auto-delete abandoned checkouts after 1 hour
        expiresAt: {
            type: Date,
            default: () => new Date(Date.now() + 60 * 60 * 1000),
        },
    },
    { timestamps: true }
)

PendingCheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.models.PendingCheckout || mongoose.model("PendingCheckout", PendingCheckoutSchema)
