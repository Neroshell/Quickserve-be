import mongoose from "mongoose"

const OrderItemSchema = new mongoose.Schema(
  {
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
    allergies: { type: [String], default: [] },
  },
  { _id: false }
)

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    tableNumber: { type: String, required: true, index: true }, // internal servicePointId — for routing/lookups only
    tableLabel: { type: String, default: "" }, // human-friendly display label, e.g. "Table 12"
    orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in", index: true },
    sessionId: { type: String, index: true },
    status: { type: String, enum: ["placed", "in_progress", "ready", "completed"], default: "placed", index: true },
    items: { type: [OrderItemSchema], required: true },
    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    platformFeeTotal: { type: Number, default: 0 },
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

    readyAt: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null, index: true },

    // Stripe fields (online payments only)
    stripeSessionId: { type: String, default: null },
    stripeCheckoutUrl: { type: String, default: null },

    // Stripe Connect split metadata — copied from PendingCheckout via webhook
    stripePaymentIntentId:    { type: String, default: null },
    stripeConnectedAccountId: { type: String, default: null },
    grossAmount:              { type: Number, default: null }, // cents
    netToBusinessAmount:      { type: Number, default: null }, // cents

    // Receipt details
    receiptEmail: { type: String, default: null },
    receiptSent:  { type: Boolean, default: false },

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

    // Offline commission tracking — prevents duplicate usage reports to Stripe
    commissionReportedToStripe: { type: Boolean, default: false, index: true },

    // Order-level commission locking — rate is frozen at order creation / payment time
    planApplied:             { type: String, enum: ["basic", "growth", "enterprise"], default: null },
    commissionRateApplied:   { type: Number, default: null },   // e.g. 2.5 (percentage)
    commissionAmountCents:   { type: Number, default: 0 },      // pre-calculated commission in cents
    stripeUsageReportedAt:   { type: Date, default: null },
    
    // Customer Feedback
    feedbackSubmitted: { type: Boolean, default: false },
  },
  { timestamps: true },
)

OrderSchema.index({ businessId: 1, orderId: 1 }, { unique: true })


export default mongoose.models.Order || mongoose.model("Order", OrderSchema)
