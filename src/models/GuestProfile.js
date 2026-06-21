import mongoose from "mongoose"

const favoriteItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, default: 0 },
  },
  { _id: false }
)

const guestProfileSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String },
    phone: { type: String },
    
    guestStatus: {
      type: String,
      enum: ["lead", "customer"],
      default: "lead",
      index: true
    },
    
    firstCapturedAt: { type: Date },
    lastCapturedAt: { type: Date },
    source: { type: String, default: "receipt" },
    
    firstOrderId: { type: String },
    lastOrderId: { type: String },
    processedOrderIds: { type: [String], default: [] }, // Prevents double counting for order count
    processedPaidOrderIds: { type: [String], default: [] }, // Prevents double counting for spend and items

    firstVisitAt: { type: Date },
    lastVisitAt: { type: Date, index: true },
    
    visitCount: { type: Number, default: 0, index: true },
    orderCount: { type: Number, default: 0 },
    paidOrderCount: { type: Number, default: 0 },
    
    totalSpendCents: { type: Number, default: 0, index: true },
    averageSpendCents: { type: Number, default: 0 }, // Per visit
    averageOrderSpendCents: { type: Number, default: 0 }, // Per order
    
    favouriteItems: { type: [favoriteItemSchema], default: [] }, // Top 10 items
    
    loyaltyPoints: { type: Number, default: 0 },
    loyaltyStatus: { type: String, default: "none" },
    
    marketingConsent: { type: Boolean, default: false, index: true },
    marketingConsentUpdatedAt: { type: Date },
    
    lastFeedbackAt: { type: Date },
    feedbackCount: { type: Number, default: 0 },
    averageRating: { type: Number },
  },
  { timestamps: true }
)

// Compound unique index so an email can only have one profile per business
guestProfileSchema.index({ businessId: 1, email: 1 }, { unique: true })

export default mongoose.models.GuestProfile || mongoose.model("GuestProfile", guestProfileSchema)
