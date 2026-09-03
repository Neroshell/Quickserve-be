import mongoose from "mongoose";

const EmailDeliverySchema = new mongoose.Schema(
  {
    deliveryId: { type: String, required: true, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    entityType: {
      type: String,
      enum: ["reservation", "billing"],
      required: true,
    },
    entityId: { type: String, required: true, index: true },
    jobName: {
      type: String,
      enum: [
        "reservation-request-owner",
        "reservation-request-guest",
        "restaurant-reservation-confirmed",
        "restaurant-reservation-cancelled",
        "reservation-arrival-reminder",
        "billing-email-upcoming-invoice",
        "billing-email-payment-success",
        "billing-email-overdue-day-3",
        "billing-email-overdue-day-5",
        "billing-email-offline-restricted",
        "billing-email-service-restored",
      ],
      required: true,
    },
    deliveryVersion: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "cancelled"],
      default: "pending",
      required: true,
      index: true,
    },
    attemptCount: { type: Number, default: 0, min: 0 },
    claimedAt: { type: Date, default: null },
    claimId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    retryable: { type: Boolean, default: true },
    providerMessageId: { type: String, default: null },
    enqueuedAt: { type: Date, default: null },
    scheduledFor: { type: Date, default: null },
    enqueueError: { type: String, default: null, maxlength: 200 },
    recipient: { type: String, default: null, lowercase: true, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

EmailDeliverySchema.index(
  { businessId: 1, jobName: 1, entityId: 1, deliveryVersion: 1 },
  { unique: true },
);
EmailDeliverySchema.index({
  businessId: 1,
  status: 1,
  retryable: 1,
  claimedAt: 1,
});

export default mongoose.models.EmailDelivery ||
  mongoose.model("EmailDelivery", EmailDeliverySchema);
