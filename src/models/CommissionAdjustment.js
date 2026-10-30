import mongoose from "mongoose"

const CommissionAdjustmentSchema = new mongoose.Schema({
  businessId: { type: String, required: true, index: true },
  accrualId: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionAccrual", required: true },
  sourceRefundId: { type: String, required: true },
  amountCents: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["pending", "applied", "credit_required", "credited"], default: "pending" },
  stripeCreditNoteId: { type: String, default: null },
}, { timestamps: true })
CommissionAdjustmentSchema.index({ businessId: 1, accrualId: 1, sourceRefundId: 1 }, { unique: true })
export default mongoose.models.CommissionAdjustment || mongoose.model("CommissionAdjustment", CommissionAdjustmentSchema, "commissionadjustments")
