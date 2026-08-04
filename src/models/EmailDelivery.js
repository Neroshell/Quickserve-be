import mongoose from "mongoose";

const EmailDeliverySchema = new mongoose.Schema(
  {
    deliveryId: { type: String, required: true, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    entityType: {
      type: String,
      enum: ["reservation"],
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
      ],
      required: true,
    },
    deliveryVersion: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed"],
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
    enqueueError: { type: String, default: null, maxlength: 200 },
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
