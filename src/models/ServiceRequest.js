import mongoose from "mongoose"

const WaiterCallSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    servicePointLabel: { type: String, required: true, index: true },
    servicePointQrCode: { type: String, default: "" },

    // Unique per-device identifier sent by the customer frontend
    // Used for device-level anti-spam and SSE notification targeting
    userDeviceId: { type: String, default: null, index: true },

    // Optional metadata (future-proof)
    reason: { type: String, default: "" },
    note: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "acknowledged", "resolved", "missed"],
      default: "pending",
      index: true,
    },

    // Multi-waiter ownership fields
    claimedBy: { type: String, default: null, index: true }, // waiter userId later, deviceId now
    claimedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null }, // stamped when call transitions → acknowledged

    acknowledgedByStaffId: { type: String, default: null },
    acknowledgedByName: { type: String, default: null },

    resolvedBy: { type: String, default: null, index: true },
    resolvedByStaffId: { type: String, default: null },
    resolvedByName: { type: String, default: null },
    resolvedAt: { type: Date, default: null },

    // Expiration and missed fields
    pendingExpiresAt: { type: Date, default: null, index: true },
    missedAt: { type: Date, default: null },

    // who created it (customer calls usually null)
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
)

export default mongoose.models.ServiceRequest || mongoose.model("ServiceRequest", WaiterCallSchema)
