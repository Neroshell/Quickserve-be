import mongoose from "mongoose"

const PlanSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    offlineCommissionRate: {
        type: Number,
        required: true,
        default: 0,
        min: 0
    },
    monthlyPrice: {
        type: Number,
        required: true,
        default: 0,
        min: 0
    },
    currency: {
        type: String,
        default: "EUR"
    },
    isActive: {
        type: Boolean,
        default: true
    },
    description: {
        type: String,
        default: ""
    },
    // Stripe Price IDs — populated by the seedStripePlans script
    stripeBasePriceId: { type: String, default: null },       // recurring monthly flat fee
    stripeMeteredPriceId: { type: String, default: null },    // per-unit offline commission
}, { timestamps: true })

export default mongoose.models.Plan || mongoose.model("Plan", PlanSchema)
