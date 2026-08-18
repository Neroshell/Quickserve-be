import mongoose from "mongoose"

const favoriteItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, default: 0 },
  },
  { _id: false }
)

const crmProjectionBaselineSchema = new mongoose.Schema(
  {
    capturedAt: { type: Date, required: true },
    firstVisitAt: { type: Date, default: null },
    lastVisitAt: { type: Date, default: null },
    firstOrderId: { type: String, default: null },
    lastOrderId: { type: String, default: null },
    visitCount: { type: Number, default: 0 },
    orderCount: { type: Number, default: 0 },
    paidOrderCount: { type: Number, default: 0 },
    totalSpendCents: { type: Number, default: 0 },
    favouriteItems: { type: [favoriteItemSchema], default: [] },
  },
  { _id: false },
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
    // Legacy compatibility snapshots only. Phase 3 deduplication is owned by
    // the durable CrmOrderProjectionLedger and never depends on these arrays.
    processedOrderIds: { type: [String], default: [] },
    processedPaidOrderIds: { type: [String], default: [] },

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

    // Serializes rebuilds of this guest's ledger-backed CRM projection.
    crmProjectionClaimId: { type: String, default: null },
    crmProjectionClaimedAt: { type: Date, default: null },
    crmProjectionBaseline: { type: crmProjectionBaselineSchema, default: null },
  },
  { timestamps: true }
)

// Compound unique index so an email can only have one profile per business
guestProfileSchema.index({ businessId: 1, email: 1 }, { unique: true })

// ─── Cursor-pagination compound indexes ──────────────────────────────────────
// Each index supports a specific CRM segment → sort combination used by
// readOwnerGuestsPage.  The _id tiebreaker guarantees deterministic ordering.

// Customers default, consent_only, no_consent, recent, inactive segments
// all sort by lastVisitAt DESC.
guestProfileSchema.index({ businessId: 1, guestStatus: 1, lastVisitAt: -1, _id: -1 })

// top_spenders segment sorts by totalSpendCents DESC.
guestProfileSchema.index({ businessId: 1, guestStatus: 1, totalSpendCents: -1, _id: -1 })

// most_orders segment sorts by orderCount DESC.
guestProfileSchema.index({ businessId: 1, guestStatus: 1, orderCount: -1, _id: -1 })

// highest_visits segment sorts by visitCount DESC.
guestProfileSchema.index({ businessId: 1, guestStatus: 1, visitCount: -1, _id: -1 })

export default mongoose.models.GuestProfile || mongoose.model("GuestProfile", guestProfileSchema)
