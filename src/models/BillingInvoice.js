import mongoose from "mongoose"

const BillingInvoiceSchema = new mongoose.Schema({
    businessId: {
        type: String,
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        default: 0
    },
    commission: {
        type: Number,
        required: true,
        default: 0
    },
    commissionRateUsed: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['paid', 'open', 'failed', 'refunded'],
        default: 'open'
    },
    billingPeriod: {
        type: String,
        required: true
    },
    stripeInvoiceId: {
        type: String
    }
}, { timestamps: true })

export default mongoose.models.BillingInvoice || mongoose.model("BillingInvoice", BillingInvoiceSchema)
