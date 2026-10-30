import mongoose from "mongoose"

const CommissionInvoiceBatchSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    billingPeriod: { type: String, required: true },
    currency: { type: String, required: true, uppercase: true },
    status: { type: String, enum: ["claimed", "held", "draft", "finalized", "paid", "failed", "void"], default: "claimed", index: true },
    accrualCount: { type: Number, required: true, min: 0 },
    amountCents: { type: Number, required: true, min: 0 },
    stripeInvoiceId: { type: String, default: null, index: true },
    stripeInvoiceItemId: { type: String, default: null },
    stripeCustomerId: { type: String, default: null },
    collectionMethod: { type: String, default: null },
    finalizedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    holdReason: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
}, { timestamps: true })

CommissionInvoiceBatchSchema.index({ businessId: 1, billingPeriod: 1, currency: 1 }, { unique: true })
export default mongoose.models.CommissionInvoiceBatch || mongoose.model("CommissionInvoiceBatch", CommissionInvoiceBatchSchema, "commissioninvoicebatches")
