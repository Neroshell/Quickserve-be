import mongoose from "mongoose";

const RefundActorSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null },
    role: { type: String, required: true },
    name: { type: String, default: null },
    email: { type: String, default: null },
  },
  { _id: false },
);

const ReservationRefundSchema = new mongoose.Schema(
  {
    refundId: { type: String, required: true, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    reservationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reservation",
      required: true,
      index: true,
    },
    paymentProvider: {
      type: String,
      enum: ["stripe"],
      default: "stripe",
      required: true,
    },
    providerPaymentId: { type: String, required: true },
    providerRefundId: { type: String },
    connectedAccountId: { type: String, default: null },
    idempotencyKey: { type: String, required: true, unique: true },
    requestFingerprint: { type: String, required: true },
    originalPaidAmountCents: { type: Number, required: true, min: 1 },
    requestedAmountCents: { type: Number, required: true, min: 1 },
    successfulAmountCents: { type: Number, default: 0, min: 0 },
    currency: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["full", "partial"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed", "cancelled"],
      default: "pending",
      required: true,
      index: true,
    },
    reason: {
      type: String,
      enum: [
        "guest_request",
        "duplicate_booking",
        "payment_issue",
        "hotel_unavailable",
        "other",
      ],
      required: true,
    },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
    requestedBy: { type: RefundActorSchema, required: true },
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null, maxlength: 500 },
    requestedAt: { type: Date, default: Date.now, required: true },
    providerCreatedAt: { type: Date, default: null },
    succeededAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    customerEmailSendingAt: { type: Date, default: null },
    customerEmailSentAt: { type: Date, default: null },
    customerEmailError: { type: String, default: null, maxlength: 500 },
    customerEmailStatus: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", null],
      default: null,
      index: true,
    },
    customerEmailAttemptCount: { type: Number, default: 0, min: 0 },
    customerEmailClaimId: { type: String, default: null },
    customerEmailRetryable: { type: Boolean, default: true },
    customerEmailEnqueuedAt: { type: Date, default: null },
    customerEmailEnqueueError: { type: String, default: null, maxlength: 200 },
    customerEmailProviderMessageId: { type: String, default: null },
  },
  { timestamps: true },
);

ReservationRefundSchema.index(
  { providerRefundId: 1 },
  { unique: true, sparse: true },
);
ReservationRefundSchema.index({
  businessId: 1,
  reservationId: 1,
  status: 1,
});
ReservationRefundSchema.index({
  businessId: 1,
  status: 1,
  customerEmailStatus: 1,
  customerEmailRetryable: 1,
});

export default mongoose.models.ReservationRefund ||
  mongoose.model("ReservationRefund", ReservationRefundSchema);
