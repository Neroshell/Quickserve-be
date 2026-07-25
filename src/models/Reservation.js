import mongoose from "mongoose";

// Minimum reservation length (minutes). There is intentionally no maximum —
// customers may reserve any length their selected time range allows.
export const MIN_DURATION_MINUTES = 30;

/** Convert an "HH:MM" string to minutes-since-midnight. Returns NaN if invalid. */
export function timeStringToMinutes(value) {
  if (typeof value !== "string") return NaN;
  const parts = value.split(":");
  if (parts.length !== 2) return NaN;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return NaN;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

const ReservationSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: true,
      index: true,
    },
    businessSlug: {
      type: String,
      required: true,
      index: true,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: function() { return !this.checkInDate; },
      index: true,
    },
    time: {
      type: String, // Legacy, keep for backward compat
      required: function() { return !this.checkInDate; },
    },
    startTime: {
      type: String, // HH:MM
      required: function() { return !this.checkInDate; },
    },
    endTime: {
      type: String, // HH:MM
      required: function() { return !this.checkInDate; },
    },
    durationMinutes: {
      type: Number,
      required: function() { return !this.checkInDate; },
      min: MIN_DURATION_MINUTES,
    },
    guestCount: {
      type: Number,
      required: true,
      min: 1,
    },
    seatingPreference: {
      type: String,
      default: "no_preference",
    },
    servicePointId: {
      type: String,
      default: null,
    },
    servicePointLabel: {
      type: String,
      default: null,
    },
    specialRequest: {
      type: String,
      maxlength: 500,
      trim: true,
    },
    status: {
      type: String,
      enum: [
        "pending", "confirmed", "cancelled", "seated", "completed", "no_show",
        "pending_approval", "accepted_awaiting_payment", "declined", "checked_in", "checked_out", "expired"
      ],
      default: "pending",
      index: true,
    },
    source: {
      type: String,
      enum: ["public_hub", "dashboard"],
      default: "public_hub",
    },
    
    // Hotel-specific fields
    checkInDate: { type: String }, // YYYY-MM-DD
    checkOutDate: { type: String }, // YYYY-MM-DD
    paymentExpiresAt: { type: Date },
    verificationCode: { type: String },
    // Price snapshot — written at booking time from ServicePoint; never recalculated from frontend input
    pricePerNight:  { type: Number, min: 0 },
    numberOfNights: { type: Number, min: 1 },
    subtotal:       { type: Number, min: 0 },
    taxRateApplied: { type: Number, min: 0 },
    taxLabel:       { type: String, default: "Tax" },
    taxAmount:      { type: Number, default: 0, min: 0 },
    taxAmountCents: { type: Number, default: 0, min: 0 },
    platformFeeLabel: { type: String, default: "Platform Fee" },
    platformFeeTotal: { type: Number, default: 0, min: 0 },
    platformFeeCents: { type: Number, default: 0, min: 0 },
    customerPlatformFeeCents: { type: Number, default: 0, min: 0 },
    businessAbsorbedPlatformFeeCents: { type: Number, default: 0, min: 0 },
    platformFeeMode: {
      type: String,
      enum: ["business_absorbs", "customer_pays", "split"],
      default: "business_absorbs",
    },
    customerPlatformFeePercent: { type: Number, default: 0, min: 0, max: 100 },
    planApplied: { type: String },
    commissionRateApplied: { type: Number, min: 0 },
    commissionAmountCents: { type: Number, default: 0, min: 0 },
    planAtOrder: { type: String },
    commissionRateAtOrder: { type: Number, min: 0 },
    platformFeeRateAtOrder: { type: Number, min: 0 },
    grossAmount: { type: Number, min: 0 }, // integer minor units
    netToBusinessAmount: { type: Number }, // integer minor units
    pricingSnapshotVersion: { type: Number, min: 1 },
    // Final amount charged to the guest. Legacy paid reservations retain the
    // historical accommodation-only value they were originally charged.
    totalPrice:     { type: Number, min: 0 },
    currency:       { type: String, lowercase: true, default: "eur" },
    stripeSessionId: { type: String },
    stripeCheckoutSessionId: { type: String },
    stripePaymentIntentId: { type: String },
    stripeConnectedAccountId: { type: String },
    amountPaidCents: { type: Number, min: 0 },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending" },
    secureToken: { type: String },
    paidAt: { type: Date },
    confirmedAt: { type: Date },
    confirmationEmailSentAt: { type: Date },
    confirmationEmailMessageId: { type: String },
    confirmationEmailError: { type: String },
    checkInCodeHash: { type: String, select: false },
    checkInCodeCreatedAt: { type: Date },
    checkInCodeValidFrom: { type: Date },
    checkInCodeExpiresAt: { type: Date },
    checkInCodeLockedAt: { type: Date },
    checkInCodeFailedAttempts: { type: Number, default: 0, min: 0 },
    checkInCodeUsedAt: { type: Date },
    checkedInAt: { type: Date },
    checkedInBy: {
      userId: { type: String },
      name: { type: String },
      email: { type: String },
      role: { type: String },
    },
    checkInCredentialVersion: { type: Number, default: 0 },
    confirmationEmailResentAt: { type: Date },
    confirmationEmailSendCount: { type: Number, default: 0 },
    publicReference: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

ReservationSchema.index({ businessId: 1, servicePointId: 1, date: 1, status: 1, startTime: 1, endTime: 1 });

// Cross-field validation: the start/end time range is the source of truth and
// must stay consistent with durationMinutes. Runs on every save (no exemptions).
ReservationSchema.pre("validate", function () {
  if (this.checkInDate) return; // Skip time validation for hotel reservations

  const start = timeStringToMinutes(this.startTime);
  const end = timeStringToMinutes(this.endTime);

  if (Number.isNaN(start)) {
    this.invalidate("startTime", "startTime must be a valid HH:MM value");
  }
  if (Number.isNaN(end)) {
    this.invalidate("endTime", "endTime must be a valid HH:MM value");
  }
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return;
  }

  if (end <= start) {
    this.invalidate("endTime", "endTime must be after startTime");
    return;
  }

  const computed = end - start;
  if (this.durationMinutes !== computed) {
    this.invalidate(
      "durationMinutes",
      `durationMinutes (${this.durationMinutes}) must match the start/end time difference (${computed} minutes)`
    );
  }
});

export default mongoose.models.Reservation || mongoose.model("Reservation", ReservationSchema);
