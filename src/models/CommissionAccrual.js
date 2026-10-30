import mongoose from "mongoose"

const CommissionAccrualSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    sourceType: { type: String, required: true, enum: ["order", "reservation"] },
    sourceId: { type: String, required: true },
    paymentConfirmationId: { type: String, required: true },
    eligibleAmountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    commissionRateApplied: { type: Number, required: true, min: 0 },
    commissionAmountCents: { type: Number, required: true, min: 0 },
    billingPeriod: { type: String, required: true },
    status: { type: String, enum: ["pending", "claimed", "invoiced", "held", "adjusted"], default: "pending", index: true },
    invoiceBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionInvoiceBatch", default: null, index: true },
    stripeInvoiceId: { type: String, default: null },
    adjustmentOf: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionAccrual", default: null },
}, { timestamps: true })

CommissionAccrualSchema.index({ businessId: 1, sourceType: 1, sourceId: 1, paymentConfirmationId: 1 }, { unique: true })
CommissionAccrualSchema.index({ businessId: 1, billingPeriod: 1, currency: 1, status: 1 })

export default mongoose.models.CommissionAccrual || mongoose.model("CommissionAccrual", CommissionAccrualSchema, "commissionaccruals")
