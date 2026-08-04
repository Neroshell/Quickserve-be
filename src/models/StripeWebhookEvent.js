import mongoose from "mongoose";

const StripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["processing", "processed", "processed_with_email_error", "failed"],
      default: "processing",
    },
    error: {
      type: String,
    },
    claimId: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    claimExpiresAt: { type: Date, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

const StripeWebhookEvent = mongoose.models.StripeWebhookEvent ||
  mongoose.model("StripeWebhookEvent", StripeWebhookEventSchema);

export default StripeWebhookEvent;
