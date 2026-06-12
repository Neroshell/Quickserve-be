import mongoose from "mongoose"

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

const BusinessSchema = new mongoose.Schema({
    businessId: { type: String, required: true, unique: true, index: true },
    // Legacy field kept for backward compat during migration
    restaurantId: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    slug: {
        type: String,
        required: true,
        unique: true,
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
    currency: { type: String, default: "USD" },
    timezone: { type: String, default: "America/New_York" },
    logoUrl: { type: String, default: "" },
    logoPublicId: { type: String, default: "" },

    // Stripe Connect — linked Express account for this business
    stripeAccountId: { type: String, default: null },
    stripeOnboardingComplete: { type: Boolean, default: false },
    stripeChargesEnabled: { type: Boolean, default: false },
    stripePayoutsEnabled: { type: Boolean, default: false },
    country: { type: String, default: "" },
    taxRate: { type: Number, default: 0, min: 0 },
    businessType: {
        type: String,
        enum: ["restaurant", "bar_lounge", "hotel_apartment"],
        default: "restaurant"
    },
    menuCategories: {
        type: [String],
        default: ["appetizers", "mains", "desserts", "beverages"]
    },
    // QuickServe MVP Billing & Plan Fields
    billingStatus: { 
        type: String, 
        enum: ['active', 'incomplete', 'past_due'], 
        default: 'incomplete' 
    },
    billingEnabled: { type: Boolean, default: false },
    currentPlan: { 
        type: String, 
        enum: ['basic', 'growth', 'enterprise'], 
        default: 'basic' 
    },
    planActivatedAt: { type: Date },
    billingCycle: { type: String, enum: ['monthly'], default: 'monthly' },
    nextBillingDate: { type: Date },
    
    passPlatformFeeToCustomer: { type: Boolean, default: false },
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
    inviteToken: { type: String, index: true },
    inviteTokenExpires: { type: Date },
    passwordResetToken: { type: String, index: true },
    passwordResetExpires: { type: Date },
    operatingHours: { type: OperatingHoursSchema, default: () => ({}) },
    // Legacy fields for backward compatibility
    orderingPreferences: { type: OrderingPreferencesSchema, default: () => ({}) },
    paymentPreferences: { type: PaymentPreferencesSchema, default: () => ({}) },
    tablePreferences: { type: TablePreferencesSchema, default: () => ({}) }
}, { timestamps: true })

// Explicitly bind to the existing "restaurants" collection — no data migration needed
export default mongoose.models.Business || mongoose.model("Business", BusinessSchema, "restaurants")
