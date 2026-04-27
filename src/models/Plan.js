import mongoose from "mongoose"

const PlanSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true
    },
    commissionPercentage: { 
        type: Number, 
        required: true, 
        default: 0,
        min: 0 
    },
    monthlyFee: { 
        type: Number, 
        required: true, 
        default: 0,
        min: 0 
    },
    currency: { 
        type: String, 
        default: "USD" 
    },
    isActive: { 
        type: Boolean, 
        default: true 
    },
    description: {
        type: String,
        default: ""
    }
}, { timestamps: true })

export default mongoose.models.Plan || mongoose.model("Plan", PlanSchema)
