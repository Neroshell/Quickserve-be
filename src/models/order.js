import mongoose from "mongoose"

const OrderItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },

    notes: { type: String, default: "" },
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
  },
  { timestamps: true },
)


export default mongoose.model("Order", OrderSchema)
