import mongoose from "mongoose";

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
      min: 30,
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

export default mongoose.models.Reservation || mongoose.model("Reservation", ReservationSchema);
