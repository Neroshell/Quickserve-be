import mongoose from "mongoose"

const customerConsentSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    marketingConsent: { type: Boolean, required: true },
  },
  { timestamps: true }
)

export default mongoose.models.CustomerConsent || mongoose.model("CustomerConsent", customerConsentSchema)
