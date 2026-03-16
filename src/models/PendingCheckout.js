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
        restaurantId: { type: String, required: true },
        orderId: { type: String, required: true },
        tableNumber: { type: String, required: true },
        orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in" },
        sessionId: { type: String, required: true },
        items: { type: [PendingItemSchema], required: true },
        total: { type: Number, default: 0 },
        currency: { type: String, default: "EUR" },
        receiptEmail: { type: String, default: null },

        // Stripe reference
        stripeSessionId: { type: String, default: null },

        // TTL: auto-delete abandoned checkouts after 1 hour
        expiresAt: {
            type: Date,
            default: () => new Date(Date.now() + 60 * 60 * 1000),
        },
    },
    { timestamps: true }
)

PendingCheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model("PendingCheckout", PendingCheckoutSchema)
