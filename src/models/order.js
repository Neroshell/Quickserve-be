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
    lineTotal: { type: Number, required: true },
    allergies: { type: [String], default: [] },
  },
  { _id: false }
)

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    tableNumber: { type: String, required: true, index: true },
    orderType: { type: String, enum: ["dine-in", "takeout"], default: "dine-in", index: true },
    sessionId: { type: String, index: true },
    status: { type: String, enum: ["placed", "in_progress", "ready", "completed"], default: "placed", index: true },
    items: { type: [OrderItemSchema], required: true },
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

    // Receipt details
    receiptEmail: { type: String, default: null },
    receiptSent: { type: Boolean, default: false },
  },
  { timestamps: true },
)


export default mongoose.model("Order", OrderSchema)
