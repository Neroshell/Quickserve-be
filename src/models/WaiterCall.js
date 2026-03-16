import mongoose from "mongoose"

const WaiterCallSchema = new mongoose.Schema(
  {
    restaurantId: { type: String, required: true, index: true },
    tableNumber: { type: String, required: true, index: true },

    // Optional metadata (future-proof)
    reason: { type: String, default: "" },
    note: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "acknowledged", "resolved"],
      default: "pending",
      index: true,
    },

    // Multi-waiter ownership fields
    claimedBy: { type: String, default: null, index: true }, // waiter userId later, deviceId now
    claimedAt: { type: Date, default: null },

    resolvedBy: { type: String, default: null, index: true },
    resolvedAt: { type: Date, default: null },

    // who created it (customer calls usually null)
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
)

export default mongoose.model("WaiterCall", WaiterCallSchema)
