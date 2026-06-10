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
      trim: true,
      lowercase: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
      index: true,
    },
    time: {
      type: String, // Legacy, keep for backward compat
      required: true,
    },
    startTime: {
      type: String, // HH:MM
      required: true,
    },
    endTime: {
      type: String, // HH:MM
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
      min: MIN_DURATION_MINUTES,
    },
    guestCount: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
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
      enum: ["pending", "confirmed", "cancelled", "seated", "completed", "no_show"],
      default: "pending",
      index: true,
    },
    source: {
      type: String,
      enum: ["public_hub", "dashboard"],
      default: "public_hub",
    },
  },
  { timestamps: true }
);

ReservationSchema.index({ businessId: 1, servicePointId: 1, date: 1, status: 1, startTime: 1, endTime: 1 });

// Cross-field validation: the start/end time range is the source of truth and
// must stay consistent with durationMinutes. Runs on every save (no exemptions).
ReservationSchema.pre("validate", function () {
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
