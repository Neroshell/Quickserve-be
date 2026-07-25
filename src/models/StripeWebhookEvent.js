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
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["processing", "processed", "processed_with_email_error", "failed"],
      default: "processing",
    },
    error: {
      type: String,
    },
  },
  { timestamps: true }
);

const StripeWebhookEvent = mongoose.model("StripeWebhookEvent", StripeWebhookEventSchema);

export default StripeWebhookEvent;
