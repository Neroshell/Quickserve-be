import mongoose from "mongoose"
import { getPendingCheckoutExpiresAt } from "../constants/checkoutRetention.js"
import {
    FULFILLMENT_BEHAVIOR_VALUES,
    FULFILLMENT_STATION_VALUES,
    FULFILLMENT_STATUS_VALUES,
} from "../constants/orderFulfillment.js"
import { generateOrderLineId } from "../utils/orderLineId.js"

/**
 * Durable Stripe Checkout attempt storage.
 *
 * Food-order attempts retain the authoritative cart until the Stripe/webhook
 * retry window closes. Reservation attempts reuse the provider-idempotency
 * fields but remain durable when financial reconciliation is required.
 */

const PendingItemSchema = new mongoose.Schema(
    {
        orderLineId: { type: String, default: generateOrderLineId, trim: true, maxlength: 100 },
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: false },
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
    { _id: false },
)

const PendingCheckoutSchema = new mongoose.Schema(
    {
        // Existing documents predate this discriminator and therefore resolve
        // to the backward-compatible food-order default.
        checkoutType: {
            type: String,
            enum: ["order", "reservation"],
            default: "order",
            immutable: true,
        },
        businessId: { type: String, required: true },
        orderId: {
            type: String,
            required() { return this.checkoutType === "order" },
        },
        servicePointId: {
            type: String,
            required() { return this.checkoutType === "order" },
        },
        displayLabel: { type: String, default: "" },
        orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in" },
        sessionId: {
            type: String,
            required() { return this.checkoutType === "order" },
        },
        // New customer order checkouts always set this. Null remains valid so
        // pre-remediation checkouts can still complete as historical records.
        guestSessionId: { type: String, default: null, immutable: true },
        journeyId: { type: String, default: null },
        items: {
            type: [PendingItemSchema],
            required() { return this.checkoutType === "order" },
        },
        subtotal: { type: Number, default: 0 },
        taxAmount: { type: Number, default: 0 },
        tipAmount: { type: Number, default: 0 },
        tipType: { type: String, enum: ["percentage", "custom", null], default: null },
        tipPercentage: { type: Number, default: null },
        total: { type: Number, default: 0 },
        currency: { type: String, default: "EUR" },
        receiptEmail: { type: String, default: null },

        // Persist customer provenance across the verified webhook boundary.
        orderSource: { type: String, enum: ["self"], default: "self", immutable: true },
        createdBy: { type: String, enum: ["customer"], default: "customer", immutable: true },
        createdByStaffId: { type: String, default: null, immutable: true },

        // Durable request and provider identity.
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
                "reconciliation_required",
            ],
            default: "provider_pending",
        },
        inventoryReservationId: { type: String, default: null, trim: true, maxlength: 100 },

        // Reservation Checkout reuses this durable attempt record. Exactly one
        // attempt per Reservation may own the active slot.
        reservationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Reservation",
            default: null,
        },
        activeReservationAttempt: { type: Boolean, default: null },
        legacyProviderSession: { type: Boolean, default: false },

        // Unexpected successful provider payments remain durable/actionable.
        reconciliationStatus: {
            type: String,
            enum: ["required", "resolved", null],
            default: null,
        },
        reconciliationReason: { type: String, default: null, maxlength: 100 },
        reconciliationEventId: { type: String, default: null, maxlength: 255 },
        reconciliationObservedAt: { type: Date, default: null },
        reconciliationExpectedAmountCents: { type: Number, default: null, min: 0 },
        reconciliationExpectedCurrency: { type: String, default: null, lowercase: true },
        reconciliationObservedAmountCents: { type: Number, default: null, min: 0 },
        reconciliationObservedCurrency: { type: String, default: null, lowercase: true },

        // Stripe reference and exact crash-safe creation request.
        stripeSessionId: { type: String, default: null },
        stripeCheckoutUrl: { type: String, default: null },
        stripeExpiresAt: { type: Date, default: null },
        stripeRequestIdempotencyKey: { type: String, default: null, trim: true, maxlength: 255 },
        stripeRequestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
        stripeCreationFailureCode: { type: String, default: null, maxlength: 100 },

        // Stripe Connect split metadata.
        stripePaymentIntentId: { type: String, default: null },
        stripeConnectedAccountId: { type: String, default: null },
        grossAmount: { type: Number, default: null }, // cents
        netToBusinessAmount: { type: Number, default: null }, // cents

        // Commission locking: the rate is frozen at checkout creation.
        planApplied: { type: String, default: null },
        commissionRateApplied: { type: Number, default: null },
        commissionAmountCents: { type: Number, default: 0 },
        planAtOrder: { type: String, default: null },
        commissionRateAtOrder: { type: Number, default: null },
        platformFeeRateAtOrder: { type: Number, default: null },

        // Platform Fee Split details.
        platformFeeCents: { type: Number, default: 0 },
        customerPlatformFeeCents: { type: Number, default: 0 },
        businessAbsorbedPlatformFeeCents: { type: Number, default: 0 },
        platformFeeMode: { type: String, enum: ["business_absorbs", "customer_pays", "split"], default: "business_absorbs" },
        customerPlatformFeePercent: { type: Number, default: 0 },

        // Reservation attempts explicitly use null so financial reconciliation
        // evidence is not removed by the food-order protocol-window TTL.
        expiresAt: {
            type: Date,
            default: () => getPendingCheckoutExpiresAt(),
        },
    },
    { timestamps: true },
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
PendingCheckoutSchema.index(
    { businessId: 1, reservationId: 1, createdAt: -1 },
    { name: "reservation_attempt_history" },
)
PendingCheckoutSchema.index(
    { reservationId: 1, activeReservationAttempt: 1 },
    {
        unique: true,
        partialFilterExpression: {
            checkoutType: "reservation",
            activeReservationAttempt: true,
        },
        name: "uniq_active_reservation_payment_attempt",
    },
)
PendingCheckoutSchema.index(
    { stripeSessionId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripeSessionId: { $type: "string" } },
    },
)

export default mongoose.models.PendingCheckout || mongoose.model("PendingCheckout", PendingCheckoutSchema)
