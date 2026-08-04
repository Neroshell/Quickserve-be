import mongoose from "mongoose"
import {
    BUSINESS_MODULES,
    getDefaultBusinessModules,
    validateBusinessModulesForType,
} from "../services/businessCapabilityService.js"

const OperatingDaySchema = new mongoose.Schema({
    enabled: { type: Boolean, default: true },
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "22:00" }
}, { _id: false })

const OperatingHoursSchema = new mongoose.Schema({
    Monday: { type: OperatingDaySchema, default: () => ({}) },
    Tuesday: { type: OperatingDaySchema, default: () => ({}) },
    Wednesday: { type: OperatingDaySchema, default: () => ({}) },
    Thursday: { type: OperatingDaySchema, default: () => ({}) },
    Friday: { type: OperatingDaySchema, default: () => ({}) },
    Saturday: { type: OperatingDaySchema, default: () => ({}) },
    Sunday: { type: OperatingDaySchema, default: () => ({}) }
}, { _id: false })

const OrderingPreferencesSchema = new mongoose.Schema({
    dineInEnabled: { type: Boolean, default: true },
    takeoutEnabled: { type: Boolean, default: false },
    callWaiterEnabled: { type: Boolean, default: true },
    hideOutOfStockItems: { type: Boolean, default: false },
    qrOrderingEnabled: { type: Boolean, default: true },
    // Allows waiters to place offline orders on behalf of customers without a QR scan.
    enableWaiterOrdering: { type: Boolean, default: true },
}, { _id: false })

const PaymentPreferencesSchema = new mongoose.Schema({
    acceptOnlinePayments: { type: Boolean, default: true },
    acceptOfflinePayments: { type: Boolean, default: true },
    acceptCash: { type: Boolean, default: true },
    acceptPosCard: { type: Boolean, default: true },
}, { _id: false })

const TablePreferencesSchema = new mongoose.Schema({
    sessionExpiryMinutes: { type: Number, default: 120, min: [1, 'Session expiry must be positive'] },
    maxActiveSessionsPerTable: { type: Number, default: 5, min: [1, 'Max active sessions must be positive'] }
}, { _id: false })

const HotelSettingsSchema = new mongoose.Schema({
    checkInTime: {
        type: String,
        default: "15:00",
        match: [/^([01]\d|2[0-3]):[0-5]\d$/, "Check-in time must be HH:mm"]
    },
    checkOutTime: {
        type: String,
        default: "11:00",
        match: [/^([01]\d|2[0-3]):[0-5]\d$/, "Check-out time must be HH:mm"]
    }
}, { _id: false })

const BillingLifecycleClaimSchema = new mongoose.Schema({
    periodKey: { type: String, default: null },
    claimId: { type: String, default: null },
    status: {
        type: String,
        enum: ["claimed", "completed", "failed"],
        default: null,
    },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    providerMessageId: { type: String, default: null },
}, { _id: false })

const BusinessSchema = new mongoose.Schema({
    businessId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    slug: {
        type: String,
        required: true,
        index: true,
        lowercase: true,
        trim: true,
        minlength: 3,
        maxlength: 40,
        match: /^[a-z0-9-]+$/
    },
    address: { type: String, default: "" },
    phoneNumber: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    currency: { type: String, default: "EUR" },
    timezone: { type: String, default: "Europe/Malta"},
    logoUrl: { type: String, default: "" },
    logoPublicId: { type: String, default: "" },

    // Stripe Connect â€” linked Express account for this business
    stripeAccountId: { type: String, default: null },
    stripeOnboardingComplete: { type: Boolean, default: false },
    stripeChargesEnabled: { type: Boolean, default: false },
    stripePayoutsEnabled: { type: Boolean, default: false },
    country: { type: String, default: "" },
    countryCode: { 
        type: String, 
        default: "mt", 
        lowercase: true, 
        trim: true, 
        index: true,
        match: /^[a-z]{2}$/
    },
    taxRate: { type: Number, default: 0, min: 0 },
    businessType: {
        type: String,
        enum: ["restaurant", "bar_lounge", "hotel"],
        default: "restaurant"
    },
    modules: {
        type: [{ type: String, enum: BUSINESS_MODULES }],
        default: function defaultBusinessModules() {
            return getDefaultBusinessModules(this.businessType)
        },
        validate: {
            validator: (value) => Array.isArray(value) && value.length > 0,
            message: "At least one business module is required"
        }
    },
    menuCategories: {
        type: [String],
        default: ["appetizers", "mains", "desserts", "beverages"]
    },
    // QuickServe MVP Billing & Plan Fields
    billingStatus: { 
        type: String, 
        enum: ['active', 'incomplete', 'past_due', 'cancelled'], 
        default: 'active' 
    },
    billingEnabled: { type: Boolean, default: false },
    currentPlan: {
        type: String,
        enum: ['basic', 'growth', 'pro', 'enterprise'],
        default: 'basic'
    },
    // Plan assignment used by the admin backoffice (createBusiness / dashboard stats).
    // `plan` is the legacy string name; `planId` references the Plan collection.
    plan: { type: String, default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
    planActivatedAt: { type: Date },
    billingCycle: { type: String, enum: ['monthly'], default: 'monthly' },
    nextBillingDate: { type: Date }, // Backward-compatible alias for nextInvoiceDate
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    nextInvoiceDate: { type: Date, default: null },
    billingReminderSentAt: { type: Date, default: null },
    billingReminderSentForPeriod: { type: String, default: null },

    billingFailedAt: { type: Date, default: null },
    overdueReminderSentAt: { type: Date, default: null },
    finalWarningSentAt: { type: Date, default: null },

    offlineServiceRestricted: { type: Boolean, default: false },
    offlineServiceRestrictedAt: { type: Date, default: null },
    offlineRestrictionEmailSentAt: { type: Date, default: null },

    billingRestoredAt: { type: Date, default: null },
    billingRestoredEmailSentAt: { type: Date, default: null },
    billingLifecycleClaims: {
        upcomingInvoice: { type: BillingLifecycleClaimSchema, default: () => ({}) },
        overdueWarningDay3: { type: BillingLifecycleClaimSchema, default: () => ({}) },
        overdueWarningDay5: { type: BillingLifecycleClaimSchema, default: () => ({}) },
        restrictService: { type: BillingLifecycleClaimSchema, default: () => ({}) },
        restoreService: { type: BillingLifecycleClaimSchema, default: () => ({}) },
    },
    
    passPlatformFeeToCustomer: { type: Boolean, default: false },
    platformFeeMode: { type: String, enum: ["business_absorbs", "customer_pays", "split"], default: "business_absorbs" },
    customerPlatformFeePercent: { type: Number, default: 0, min: 0, max: 100 },
    platformFeeLabel: { type: String, default: "Platform Fee" },
    
    // Stripe Payment Method (Safe display metadata only)
    stripeCustomerId: { type: String },
    defaultPaymentMethodId: { type: String },
    paymentMethodBrand: { type: String },
    paymentMethodLast4: { type: String },
    paymentMethodExpMonth: { type: Number },
    paymentMethodExpYear: { type: Number },
    // QuickServe Stripe Subscription (Metered Billing)
    stripeSubscriptionId: { type: String, default: null, index: true },
    stripeMeteredSubscriptionItemId: { type: String, default: null }, // Used to report usage records
    stripeSubscriptionStatus: { type: String, default: "incomplete" }, // Synced from Stripe webhooks
    scheduledDowngradePlan: { type: String, default: null }, // Pending downgrade at period end
    scheduledPlanEffectiveDate: { type: Date, default: null },
    status: { 
        type: String, 
        enum: ["draft", "active", "suspended", "archived"], 
        default: "draft" 
    },
    language: { type: String, default: "en" },
    branding: {
        enabled: { type: Boolean, default: false },
        logoUrl: { type: String, default: null },
        coverImageUrl: { type: String, default: null },
        primaryColor: { type: String, default: "#EA601A" },
        secondaryColor: { type: String, default: "#2B304C" },
        accentColor: { type: String, default: "#FB923C" },
        backgroundColor: { type: String, default: "#F8F9FA" },
        removeQuickServeBranding: { type: Boolean, default: false }
    },
    settings: {
        onlinePaymentEnabled: { type: Boolean, default: true },
        offlinePaymentEnabled: { type: Boolean, default: true },
        acceptCash: { type: Boolean, default: true },
        acceptPOS: { type: Boolean, default: true },
        dineInEnabled: { type: Boolean, default: true },
        takeoutEnabled: { type: Boolean, default: false },
        callWaiterEnabled: { type: Boolean, default: true },
        reservationsEnabled: { type: Boolean, default: true },
        tipsEnabled: { type: Boolean, default: false },
    },
    notes: { type: String, default: "" },
    ownerName: { type: String, required: false },
    ownerEmail: { 
        type: String, 
        required: false, 
        unique: true, 
        sparse: true,
        lowercase: true, 
        trim: true,
        index: true
    },
    ownerStatus: { 
        type: String, 
        enum: ["pending", "active", "disabled"], 
        default: "pending" 
    },
    ownerPasswordHash: { type: String },
    inviteToken: { type: String, index: true, select: false },
    inviteTokenExpires: { type: Date },
    passwordResetToken: { type: String, index: true, select: false },
    passwordResetExpires: { type: Date },
    // Pending email change (verified via magic link before committing)
    pendingEmailChange: { type: String, default: null },
    emailChangeToken: { type: String, index: true, select: false },
    emailChangeTokenExpires: { type: Date, default: null },
    operatingHours: { type: OperatingHoursSchema, default: () => ({}) },
    // Legacy fields for backward compatibility
    orderingPreferences: { type: OrderingPreferencesSchema, default: () => ({}) },
    paymentPreferences: { type: PaymentPreferencesSchema, default: () => ({}) },
    tablePreferences: { type: TablePreferencesSchema, default: () => ({}) },
    hotelSettings: { type: HotelSettingsSchema, default: () => ({}) },
    
    // Post-signup Onboarding Tracking
    onboardingCompleted: { type: Boolean, default: false },
    onboardingStep: { type: String, default: null },
    onboardingStartedAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
   
    
    setupChecklist: {
        businessProfileCompleted: { type: Boolean, default: false },
        operatingHoursCompleted: { type: Boolean, default: false },
        preferencesCompleted: { type: Boolean, default: false },
        billingCardCompleted: { type: Boolean, default: false },
        stripeConnectCompleted: { type: Boolean, default: false },
        servicePointsCompleted: { type: Boolean, default: false },
        menuCompleted: { type: Boolean, default: false },
        teamCompleted: { type: Boolean, default: false },
        previewCompleted: { type: Boolean, default: false }
    },
    setupProgress: {
        setupGuideDismissed: { type: Boolean, default: false },
        setupGuideDismissedAt: { type: Date, default: null }
    }
}, { timestamps: true })

BusinessSchema.pre("validate", function normalizeModulesBeforeValidation() {
    this.modules = validateBusinessModulesForType(this.businessType, this.modules)
})

// Compound index to ensure slug is unique per country
BusinessSchema.index({ countryCode: 1, slug: 1 }, { unique: true })
BusinessSchema.index({ billingStatus: 1, nextInvoiceDate: 1 })
BusinessSchema.index({ billingStatus: 1, billingFailedAt: 1 })
BusinessSchema.index({ billingStatus: 1, offlineServiceRestricted: 1 })

// Explicitly bind to the existing "restaurants" collection
export default mongoose.models.Business || mongoose.model("Business", BusinessSchema, "restaurants")
