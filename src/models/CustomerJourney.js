import mongoose from "mongoose"

const CustomerJourneySchema = new mongoose.Schema(
  {
    journeyId: { type: String, required: true, unique: true },
    businessId: { type: String, required: true },
    servicePointId: { type: String, default: null },
    orderType: {
      type: String,
      enum: ["dine-in", "takeout", null],
      default: null,
    },
    sessionId: { type: String, default: null },
    tableSessionToken: { type: String, default: null },
    localBusinessDate: { type: String, required: true }, // YYYY-MM-DD

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },

    firstOrderedAt: { type: Date, default: null },
    lastOrderedAt: { type: Date, default: null },
    // A paid takeaway order closes the browser/device-scoped takeaway visit.
    // Dine-in journeys remain open for additional orders until their table
    // session expires or a new QR bootstrap creates a new journey.
    completedAt: { type: Date, default: null },

    identifiedAt: { type: Date, default: null },
    guestProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GuestProfile",
      default: null,
    },

    orderCount: { type: Number, default: 0, min: 0 }, // Placed orders
    paidOrderCount: { type: Number, default: 0, min: 0 }, // Paid orders
    totalSpendCents: { type: Number, default: 0, min: 0 }, // Paid spend in cents

    // Separate idempotency trackers for placement vs payment facts
    placedOrderIds: { type: [String], default: [] },
    paidOrderIds: { type: [String], default: [] },
  },
  { timestamps: true, collection: "customerjourneys" },
)

// Period funnel/trend aggregation.
CustomerJourneySchema.index({ businessId: 1, localBusinessDate: 1 })
// Dine-in fallback resolution from the validated GuestSession token.
CustomerJourneySchema.index(
  { businessId: 1, tableSessionToken: 1 },
  { partialFilterExpression: { tableSessionToken: { $type: "string" } } },
)
// Safe direct/takeaway fallback: only an unfinished journey from the same
// device and operational day may be reused.
CustomerJourneySchema.index(
  { businessId: 1, sessionId: 1, localBusinessDate: 1, completedAt: 1 },
  { partialFilterExpression: { sessionId: { $type: "string" } } },
)
// Profile linkage and tenant-local tracking availability lookup.
CustomerJourneySchema.index(
  { businessId: 1, guestProfileId: 1 },
  { partialFilterExpression: { guestProfileId: { $type: "objectId" } } },
)
CustomerJourneySchema.index({ businessId: 1, firstSeenAt: 1 })

export default mongoose.models.CustomerJourney ||
  mongoose.model("CustomerJourney", CustomerJourneySchema)
