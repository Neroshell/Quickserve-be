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
    sessionId: { type: String, index: true }, // optional but scalable
    status: {
      type: String,
      enum: ["placed", "in_progress", "ready", "completed"],
      default: "placed",
      index: true,
    },
    items: { type: [OrderItemSchema], required: true },
  },
  { timestamps: true }
)

export default mongoose.model("Order", OrderSchema)
