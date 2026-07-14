import mongoose from "mongoose"

const BusinessDataSchema = new mongoose.Schema({
    name: { type: String },
    displayName: { type: String },
    businessType: { type: String },
    slug: { type: String },
    
    country: { type: String },
    countryCode: { type: String },
    address: { type: String },
    contactEmail: { type: String },
    phoneNumber: { type: String },
    
    currency: { type: String },
    timezone: { type: String },
    language: { type: String },
    
    plan: { type: String },
    currentPlan: { type: String },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" }
}, { _id: false })

const OnboardingSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    ownerEmail: { 
        type: String, 
        required: true, 
        lowercase: true, 
        trim: true,
        index: true
    },
    ownerName: { type: String, required: true },
    passwordHash: { type: String, required: true },
    
    emailVerified: { type: Boolean, default: false },
    verificationToken: { type: String, select: false },
    verificationTokenExpires: { type: Date },
    
    currentStep: { type: String, default: 'verify_email' }, // e.g. verify_email, business_identity, location, localization, plan
    
    businessData: { type: BusinessDataSchema, default: () => ({}) },
    
    // Auto-expire sessions after 7 days if not completed
    createdAt: { type: Date, default: Date.now, expires: '7d' }
}, { timestamps: true })

// Ensure only one active onboarding session per email
OnboardingSessionSchema.index({ ownerEmail: 1 }, { unique: true })

export default mongoose.models.OnboardingSession || mongoose.model("OnboardingSession", OnboardingSessionSchema)
