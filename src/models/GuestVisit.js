import mongoose from "mongoose";

const guestVisitSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    visitDate: { type: String, required: true }, // Format: YYYY-MM-DD in business local timezone
    
    orderIds: { type: [String], default: [] },
    paidOrderIds: { type: [String], default: [] },
    spendCents: { type: Number, default: 0 },
    crmProjectionBaseline: {
      capturedAt: { type: Date, default: null },
      existed: { type: Boolean, default: false },
      orderIds: { type: [String], default: [] },
      paidOrderIds: { type: [String], default: [] },
      spendCents: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// Compound unique index to ensure exactly one visit document per guest per day
guestVisitSchema.index({ businessId: 1, email: 1, visitDate: 1 }, { unique: true });

export default mongoose.models.GuestVisit || mongoose.model("GuestVisit", guestVisitSchema);
