import mongoose from "mongoose"
import {
    BUSINESS_MODULES,
    getDefaultBusinessModules,
    validateBusinessModulesForType,
} from "../services/businessCapabilityService.js"
import {
    DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES,
    MAX_ORDER_START_ASSISTANCE_DELAY_MINUTES,
    MIN_ORDER_START_ASSISTANCE_DELAY_MINUTES,
} from "../utils/customerOrderTiming.js"
import {
    PROPERTY_ACCOMMODATION_TYPES,
    PROPERTY_FACILITY_IDS,
    PROPERTY_LANGUAGE_IDS,
} from "../constants/propertyProfileCatalog.js"
import {
    INVENTORY_UNIT_VALUES,
    MAX_INVENTORY_QUANTITY,
} from "../constants/inventory.js"

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
    orderStartAssistanceDelayMinutes: {
        type: Number,
        default: DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES,
        min: MIN_ORDER_START_ASSISTANCE_DELAY_MINUTES,
        max: MAX_ORDER_START_ASSISTANCE_DELAY_MINUTES,
        validate: {
            validator: Number.isInteger,
            message: "Order start assistance delay must be a whole number of minutes",
        },
    },
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
    },
    checkInUntil: {
        type: String,
        default: "22:00",
        match: [/^([01]\d|2[0-3]):[0-5]\d$/, "Check-in until must be HH:mm"]
    },
    checkOutFrom: {
        type: String,
        default: "07:00",
        match: [/^([01]\d|2[0-3]):[0-5]\d$/, "Check-out from must be HH:mm"]
    },
    onlineBookingConfirmationMode: {
        type: String,
        enum: ["instant", "confirmation_required"],
        default: "instant"
    }
}, { _id: false })

const HousekeepingSettingsSchema = new mongoose.Schema({
    // No default SLA is assumed. A room is overdue only after management has
    // explicitly configured the corresponding operational target.
    targetStartMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: 10080,
        validate: {
            validator: (value) => value === null || Number.isInteger(value),
            message: "Housekeeping start target must be a whole number of minutes",
        },
    },
    targetCleaningMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: 10080,
        validate: {
            validator: (value) => value === null || Number.isInteger(value),
            message: "Housekeeping cleaning target must be a whole number of minutes",
        },
    },
}, { _id: false })

const PropertyPhotoSchema = new mongoose.Schema({
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    publicId: { type: String, required: true, trim: true, maxlength: 500 },
}, { timestamps: true })

const PropertyParkingSchema = new mongoose.Schema({
    available: { type: Boolean, default: null },
    cost: { type: String, enum: ["free", "paid", null], default: null },
    reservation: { type: String, enum: ["required", "not_required", null], default: null },
    location: { type: String, enum: ["onsite", "offsite", null], default: null },
    access: { type: String, enum: ["private", "public", null], default: null },
}, { _id: false })

const PropertyProfileSchema = new mongoose.Schema({
    accommodationType: {
        type: String,
        enum: [...PROPERTY_ACCOMMODATION_TYPES.map(type => type.id), null],
        default: null,
    },
    description: { type: String, default: "", trim: true, maxlength: 3000 },
    starRating: { type: Number, min: 1, max: 5, default: null },
    city: { type: String, default: "", trim: true, maxlength: 120 },
    region: { type: String, default: "", trim: true, maxlength: 120 },
    postalCode: { type: String, default: "", trim: true, maxlength: 32 },
    photos: { type: [PropertyPhotoSchema], default: [] },
    facilityIds: {
        type: [{ type: String, enum: PROPERTY_FACILITY_IDS }],
        default: [],
    },
    parking: { type: PropertyParkingSchema, default: () => ({}) },
    breakfastOffered: { type: Boolean, default: null },
    languages: {
        type: [{ type: String, enum: PROPERTY_LANGUAGE_IDS }],
        default: [],
    },
    childrenAllowed: { type: Boolean, default: null },
    petsPolicy: {
        type: String,
        enum: ["allowed", "on_request", "not_allowed", null],
        default: null,
    },
    websiteUrl: { type: String, default: "", trim: true, maxlength: 2048 },
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

const HotelRoomTypeSupplyTemplateItemSchema = new mongoose.Schema({
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    quantity: {
        type: Number,
        required: true,
        validate: {
            validator(value) {
                return Number.isFinite(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
            },
            message: "Room supply template quantity must be positive",
        },
    },
    unit: { type: String, required: true, enum: INVENTORY_UNIT_VALUES },
    canonicalQuantity: {
        type: Number,
        required: true,
        min: 1,
        max: MAX_INVENTORY_QUANTITY,
        validate: Number.isSafeInteger,
    },
}, { _id: false })

const HotelRoomTypeSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80 },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    description: { type: String, default: "", trim: true, maxlength: 500 },
    roomSize: { type: Number, default: null, min: 0 },
    roomSizeUnit: {
        type: String,
        enum: ["m2", "ft2"],
        default: "m2",
    },
    maxGuests: { type: Number, default: null, min: 1 },
    bedConfiguration: [{
        bedType: { type: String, trim: true, maxlength: 80 },
        count: { type: Number, min: 1 },
    }],
    viewType: { type: String, default: "", trim: true, maxlength: 80 },
    amenities: [{ type: String, trim: true, maxlength: 80 }],
    images: [{ type: String, trim: true, maxlength: 2048 }],
    standardSupplyTemplate: {
        type: [HotelRoomTypeSupplyTemplateItemSchema],
        default: [],
    },
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
    addressPlaceId: { type: String, default: "" },
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
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
    hotelRoomTypes: {
        type: [HotelRoomTypeSchema],
        default: function defaultHotelRoomTypes() {
            if (this.businessType !== "hotel") return undefined
            return []
        }
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
        arrivalReminderEnabled: { type: Boolean, default: true },
        arrivalReminderLeadMinutes: {
            type: Number,
            default: 10,
            min: 0,
            max: 10080,
            validate: {
                validator: Number.isInteger,
                message: "Arrival reminder lead time must be a whole number of minutes",
            },
        },
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
    // Mirrors Staff authVersion for the Business-owned primary identity while
    // keeping the two authentication lifecycles distinct.
    ownerAuthVersion: { type: Number, default: 0, min: 0 },
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
    housekeepingSettings: { type: HousekeepingSettingsSchema, default: () => ({}) },
    propertyProfile: {
        type: PropertyProfileSchema,
        default: function defaultPropertyProfile() {
            return this.businessType === "hotel" ? {} : undefined
        },
    },
    
    // Post-signup Onboarding Tracking
    // Note: onboardingCompleted represents 'required operational setup complete'. 
    onboardingCompleted: { type: Boolean, default: false },
    onboardingStep: { type: String, default: null },
    onboardingStartedAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
   
    // @deprecated - Phase 1 roadmap: setupChecklist is dead. 
    // Data is preserved for backward compatibility but no longer updated.
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

const OWNER_AUTH_VERSION_PATHS = ["ownerStatus", "ownerEmail"]

BusinessSchema.pre("save", function incrementOwnerAuthVersionForSensitiveSave() {
    if (this.isNew || !OWNER_AUTH_VERSION_PATHS.some((path) => this.isModified(path))) return
    const current = Number(this.ownerAuthVersion)
    this.ownerAuthVersion = (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1
})

function ownerUpdateTouchesSensitiveAuthState(update = {}) {
    return OWNER_AUTH_VERSION_PATHS.some((path) => (
        Object.hasOwn(update, path) ||
        Object.hasOwn(update.$set || {}, path) ||
        Object.hasOwn(update.$unset || {}, path)
    ))
}

function incrementOwnerAuthVersionForSensitiveQueryUpdate() {
    const update = this.getUpdate() || {}
    if (!ownerUpdateTouchesSensitiveAuthState(update)) return

    delete update.ownerAuthVersion
    if (update.$set) delete update.$set.ownerAuthVersion
    update.$inc = {
        ...(update.$inc || {}),
        ownerAuthVersion: Number(update.$inc?.ownerAuthVersion || 0) + 1,
    }
    this.setUpdate(update)
}

BusinessSchema.pre("findOneAndUpdate", incrementOwnerAuthVersionForSensitiveQueryUpdate)
BusinessSchema.pre("updateOne", incrementOwnerAuthVersionForSensitiveQueryUpdate)
BusinessSchema.pre("updateMany", incrementOwnerAuthVersionForSensitiveQueryUpdate)

// Compound index to ensure slug is unique per country
BusinessSchema.index({ countryCode: 1, slug: 1 }, { unique: true })
BusinessSchema.index({ billingStatus: 1, nextInvoiceDate: 1 })
BusinessSchema.index({ billingStatus: 1, billingFailedAt: 1 })
BusinessSchema.index({ billingStatus: 1, offlineServiceRestricted: 1 })

// Keep the canonical collection explicit; never rely on Mongoose pluralization.
export default mongoose.models.Business || mongoose.model("Business", BusinessSchema, "businesses")
