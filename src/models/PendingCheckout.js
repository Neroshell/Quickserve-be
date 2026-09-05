import mongoose from "mongoose"
import { getPendingCheckoutExpiresAt } from "../constants/checkoutRetention.js"
import {
    FULFILLMENT_BEHAVIOR_VALUES,
    FULFILLMENT_STATION_VALUES,
    FULFILLMENT_STATUS_VALUES,
} from "../constants/orderFulfillment.js"
import { generateOrderLineId } from "../utils/orderLineId.js"

/**
 * Temporary storage for cart data while the customer is completing
 * Stripe Checkout. Once payment is confirmed via webhook, the data
 * here is used to create the real Order. Phase 4 checkouts are retained for
 * durable request/provider idempotency until the TTL window closes.
 *
 * Auto-expires only after Stripe's payment and webhook-delivery windows close.
 */

const PendingItemSchema = new mongoose.Schema(
    {
        orderLineId: { type: String, default: generateOrderLineId, trim: true, maxlength: 100 },
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
        itemName: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        lineTotal: { type: Number, required: true },
        prepTimeMinutes: { type: Number, default: null },
        category: { type: String, default: "mains" },
        type: { type: String, enum: ["food", "drinks"], default: "food" },
        notes: { type: String, default: "" },
        allergies: { type: [String], default: [] },
        fulfillmentStation: { type: String, enum: [...FULFILLMENT_STATION_VALUES, null], default: null },
        fulfillmentBehavior: { type: String, enum: [...FULFILLMENT_BEHAVIOR_VALUES, null], default: null },
        fulfillmentStatus: { type: String, enum: [...FULFILLMENT_STATUS_VALUES, null], default: null },
        fulfillmentStartedAt: { type: Date, default: null },
        fulfillmentStartedBy: { type: mongoose.Schema.Types.Mixed, default: null },
        fulfillmentReadyAt: { type: Date, default: null },
        fulfillmentReadyBy: { type: mongoose.Schema.Types.Mixed, default: null },
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

        // Durable request identity. New restaurant checkouts retain this record
        // through the Stripe/webhook retry window instead of deleting it as
        // soon as the first webhook arrives.
        idempotencyKey: { type: String, default: null, trim: true, maxlength: 200 },
        requestFingerprint: {
            type: String,
            default: null,
            match: /^[a-f0-9]{64}$/,
        },
        status: {
            type: String,
            enum: [
                "provider_pending",
                "open",
                "completed",
                "expired",
                "creation_failed",
                "inventory_exception",
            ],
            default: "provider_pending",
        },
        inventoryReservationId: { type: String, default: null, trim: true, maxlength: 100 },

        // Stripe reference
        stripeSessionId: { type: String, default: null },
        stripeCheckoutUrl: { type: String, default: null },
        stripeExpiresAt: { type: Date, default: null },
        stripeRequestIdempotencyKey: { type: String, default: null, trim: true, maxlength: 255 },
        // Exact provider request snapshot used only for crash-safe replay with
        // Stripe's idempotency key. It is temporary along with PendingCheckout.
        stripeRequestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
        stripeCreationFailureCode: { type: String, default: null, maxlength: 100 },

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
PendingCheckoutSchema.index(
    { businessId: 1, idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: "string" } },
    },
)
PendingCheckoutSchema.index({ businessId: 1, inventoryReservationId: 1 })
PendingCheckoutSchema.index({ stripeSessionId: 1 }, {
    unique: true,
    partialFilterExpression: { stripeSessionId: { $type: "string" } },
})

export default mongoose.models.PendingCheckout || mongoose.model("PendingCheckout", PendingCheckoutSchema)
