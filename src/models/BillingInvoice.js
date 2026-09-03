import mongoose from "mongoose"

function minorUnitAmount() {
    return {
        type: Number,
        min: 0,
        default: 0,
        validate: {
            validator: Number.isSafeInteger,
            message: "Billing invoice minor-unit amounts must be safe integers",
        },
    }
}

const BillingInvoiceSchema = new mongoose.Schema({
    businessId: {
        type: String,
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
    },
    commission: {
        type: Number,
        required: true,
        default: 0
    },
    commissionRateUsed: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
    },
    status: {
        type: String,
        enum: ['draft', 'paid', 'open', 'failed', 'refunded', 'void', 'uncollectible'],
        default: 'open'
    },
    billingPeriod: {
        type: String,
        required: true
    },
    stripeInvoiceId: {
        type: String,
        trim: true,
    },
    stripeSubscriptionId: { type: String, default: null, index: true },
    stripeCustomerId: { type: String, default: null, index: true },
    currency: { type: String, uppercase: true, trim: true, default: null },
    // Stripe monetary fields are always persisted as integer minor units.
    amountDue: minorUnitAmount(),
    amountPaid: minorUnitAmount(),
    subtotal: minorUnitAmount(),
    tax: minorUnitAmount(),
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    hostedInvoiceUrl: { type: String, default: null },
    invoicePdf: { type: String, default: null },
    stripeCreatedAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
}, { timestamps: true })

// Stripe invoice IDs are globally unique. Sparse preserves legacy rows that
// predate the durable Stripe invoice ledger and have no external identity.
BillingInvoiceSchema.index(
    { stripeInvoiceId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            stripeInvoiceId: { $type: "string", $gt: "" },
        },
    },
)
BillingInvoiceSchema.index({ businessId: 1, stripeCreatedAt: -1, createdAt: -1 })

export default mongoose.models.BillingInvoice || mongoose.model("BillingInvoice", BillingInvoiceSchema, "billinginvoices")
