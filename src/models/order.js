import mongoose from "mongoose"

const OrderItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: false },
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },

    type: {
      type: String,
      enum: ["food", "drinks"],
      default: "food"
    },
    category: {
      type: String,
      default: "mains"
    },
    notes: { type: String, default: "" },
    image: { type: String, default: "" },
    lineTotal: { type: Number, required: true },
    prepTimeMinutes: { type: Number, default: null },
    allergies: { type: [String], default: [] },
  },
  { _id: false }
)

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    servicePointLabel: { type: String, required: true, index: true }, // internal servicePointId â€” for routing/lookups only
    displayLabel: { type: String, default: "" }, // human-friendly display label, e.g. "Table 12"
    orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in", index: true },
    sessionId: { type: String, index: true },
    journeyId: { type: String, default: null },
    status: { type: String, enum: ["placed", "in_progress", "ready", "completed", "cancelled"], default: "placed", index: true },
    items: { type: [OrderItemSchema], required: true },
    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    platformFeeTotal: { type: Number, default: 0 },
    tipAmount: { type: Number, default: 0 },
    tipType: { type: String, enum: ["percentage", "custom", null], default: null },
    tipPercentage: { type: Number, default: null },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "EUR" },

    // Payment fields
    paymentChannel: {
      type: String,
      enum: ["online", "offline"],
      default: "offline",
      index: true
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "paid"],
      default: "unpaid",
      index: true
    },
    paidVia: {
      type: String,
      enum: ["online_card", "pos_card", "cash"],
      default: null
    },
    paidAt: { type: Date, default: null, index: true },

    readyAt: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null, index: true },
    estimatedPrepMinutes: { type: Number, default: null, min: 0 },
    estimatedReadyAt: { type: Date, default: null, index: true },

    // Stripe fields (online payments only)
    stripeSessionId: { type: String, default: null },
    stripeCheckoutUrl: { type: String, default: null },

    // Stripe Connect split metadata â€” copied from PendingCheckout via webhook
    stripePaymentIntentId:    { type: String, default: null },
    stripeConnectedAccountId: { type: String, default: null },
    grossAmount:              { type: Number, default: null }, // cents
    netToBusinessAmount:      { type: Number, default: null }, // cents

    // Receipt details
    receiptEmail: { type: String, default: null },
    receiptSent:  { type: Boolean, default: false },
    receiptSentAt: { type: Date, default: null },
    receiptDeliveryStatus: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", null],
      default: null,
      index: true,
    },
    receiptDeliveryAttemptCount: { type: Number, default: 0, min: 0 },
    receiptDeliveryClaimedAt: { type: Date, default: null },
    receiptDeliveryClaimId: { type: String, default: null },
    receiptDeliveryLastError: { type: String, default: null, maxlength: 500 },
    receiptDeliveryRetryable: { type: Boolean, default: true },
    receiptDeliveryEnqueuedAt: { type: Date, default: null },
    receiptDeliveryEnqueueError: { type: String, default: null, maxlength: 200 },
    receiptProviderMessageId: { type: String, default: null },

    // CRM Ownership Locks
    crmEmail: { type: String, default: null },
    crmProcessed: { type: Boolean, default: false },
    crmProcessedAt: { type: Date, default: null },
    crmProcessingStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", null],
      default: null,
      index: true,
    },
    crmProcessingClaimId: { type: String, default: null },
    crmProcessingClaimedAt: { type: Date, default: null },
    crmProcessingAttemptCount: { type: Number, default: 0, min: 0 },
    crmProcessingFailedAt: { type: Date, default: null },
    crmProcessingLastError: { type: String, default: null, maxlength: 500 },
    crmProcessingRetryable: { type: Boolean, default: true },
    crmProcessingEnqueuedAt: { type: Date, default: null },
    crmProcessingEnqueueError: { type: String, default: null, maxlength: 200 },

    // Order creation metadata
    orderSource: { type: String, enum: ["self", "waitstaff"], default: "self", index: true },
    createdBy: { type: String, enum: ["customer", "staff"], default: "customer" },
    createdByStaffId: { type: String, default: null, index: true },

    // Staff attribution
    completedBy: { type: String, default: null },
    // Payment confirmed by staff (offline POS/cash payments via waiter)
    paidByStaffId: { type: String, default: null, index: true },
    paidByName:    { type: String, default: null },
    // Order served/delivered by waiter (Mark Served action)
    servedByStaffId: { type: String, default: null, index: true },
    servedByName:    { type: String, default: null },
    servedAt:        { type: Date,   default: null },

    // Offline commission tracking â€” prevents duplicate usage reports to Stripe
    commissionReportedToStripe: { type: Boolean, default: false, index: true },

    // Order-level commission locking â€” rate is frozen at order creation / payment time
    planApplied:             { type: String, enum: ["basic", "growth", "pro", "enterprise"], default: null },
    commissionRateApplied:   { type: Number, default: null },   // e.g. 2.5 (percentage)
    commissionAmountCents:   { type: Number, default: 0 },      // pre-calculated commission in cents
    planAtOrder:             { type: String, enum: ["basic", "growth", "pro", "enterprise"], default: null },
    commissionRateAtOrder:   { type: Number, default: null },
    platformFeeRateAtOrder:  { type: Number, default: null },
    
    // Platform Fee Split details
    platformFeeCents: { type: Number, default: 0 },
    customerPlatformFeeCents: { type: Number, default: 0 },
    businessAbsorbedPlatformFeeCents: { type: Number, default: 0 },
    platformFeeMode: { type: String, enum: ["business_absorbs", "customer_pays", "split"], default: "business_absorbs" },
    customerPlatformFeePercent: { type: Number, default: 0 },
    
    stripeUsageReportedAt:   { type: Date, default: null },
    
    // Inventory Tracking
    inventoryDeducted: { type: Boolean, default: false },
    inventoryDeductedAt: { type: Date, default: null },
    inventoryRestored: { type: Boolean, default: false },
    inventoryRestoredAt: { type: Date, default: null },

    // Cancellation
    cancelledAt: { type: Date, default: null },
    cancelledByStaffId: { type: String, default: null, index: true },
    
    // Customer Feedback
    feedbackSubmitted: { type: Boolean, default: false },
  },
  { timestamps: true },
)

OrderSchema.index({ businessId: 1, orderId: 1 }, { unique: true })
// Supports tenant-scoped paid-revenue analytics on the authoritative payment time.
OrderSchema.index({ businessId: 1, paymentStatus: 1, paidAt: 1 })
// Supports tenant-scoped operational analytics over order creation and status.
OrderSchema.index({ businessId: 1, createdAt: 1, status: 1 })
// Supports stable owner-order cursor pagination without a status filter.
OrderSchema.index({ businessId: 1, createdAt: -1, _id: -1 })
// Supports stable owner-order cursor pagination for a selected status.
OrderSchema.index({ businessId: 1, status: 1, createdAt: -1, _id: -1 })
OrderSchema.index({
  businessId: 1,
  paymentStatus: 1,
  receiptDeliveryStatus: 1,
  receiptDeliveryRetryable: 1,
})
OrderSchema.index({
  businessId: 1,
  paymentStatus: 1,
  crmProcessed: 1,
  crmProcessingStatus: 1,
  crmProcessingRetryable: 1,
  crmProcessingClaimedAt: 1,
  paidAt: 1,
})


export default mongoose.models.Order || mongoose.model("Order", OrderSchema)
