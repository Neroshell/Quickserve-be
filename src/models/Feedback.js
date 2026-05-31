import mongoose from "mongoose"

const FeedbackSchema = new mongoose.Schema(
    {
        businessId: { type: String, required: true, index: true },
        orderId: { type: String, required: true, unique: true }, // MongoDB unique index guarantees exactly 1 review per order
        sessionId: { type: String, required: true },
        
        overallRating: { type: Number, required: true, min: 1, max: 5, index: true },
        tags: [{ type: String }],
        
        comment: { type: String, maxlength: 500, default: "" },
        
        sentiment: {
            type: String,
            enum: ["positive", "neutral", "negative"],
            default: "neutral"
        },
        
        wouldRecommend: { type: Boolean, default: null },
        
        customerType: { type: String, default: "guest" },
        orderType: { type: String, required: true }, // dine-in, takeout, delivery
        servicePointId: { type: String, default: null, index: true }, // table number, etc.
        orderValue: { type: Number, default: 0 } // Amount spent to correlate with rating
    },
    { timestamps: true }
)

// Add compound indexes for efficient analytics queries
FeedbackSchema.index({ businessId: 1, createdAt: -1 })
FeedbackSchema.index({ businessId: 1, overallRating: 1 })
FeedbackSchema.index({ businessId: 1, servicePointId: 1 })

export default mongoose.models.Feedback || mongoose.model("Feedback", FeedbackSchema)
