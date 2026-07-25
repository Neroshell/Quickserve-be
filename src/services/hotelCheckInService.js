import crypto from "crypto";
import { DateTime } from "luxon";
import Reservation from "../models/Reservation.js";
import { sendHotelPaymentConfirmationEmail } from "../utils/emailService.js";
import { hashCheckInCode } from "../utils/checkInCode.js";

function parseHotelTime(value, fallbackHour, fallbackMinute) {
  const [hour, minute] = String(value || "").split(":").map(Number);
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallbackHour,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : fallbackMinute,
  };
}

export function getHotelCheckInWindow(reservation, business) {
  const timezone = business.timezone || "UTC";
  const checkInTimeStr = business.hotelSettings?.checkInTime || "15:00";
  const checkOutTimeStr = business.hotelSettings?.checkOutTime || "11:00";
  const checkInTime = parseHotelTime(checkInTimeStr, 15, 0);
  const checkOutTime = parseHotelTime(checkOutTimeStr, 11, 0);

  return {
    checkInCodeValidFrom: DateTime.fromISO(reservation.checkInDate, { zone: timezone })
      .set({ hour: checkInTime.hour, minute: checkInTime.minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate(),
    checkInCodeExpiresAt: DateTime.fromISO(reservation.checkOutDate, { zone: timezone })
      .set({ hour: checkOutTime.hour, minute: checkOutTime.minute, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate(),
  };
}

/**
 * Generates credentials and sends the confirmation email for a hotel reservation.
 * Safely handles retries by generating new credentials and replacing old hashes.
 *
 * @param {Object} reservation - The Reservation mongoose document
 * @param {Object} business - The Business mongoose document (must include timezone/hotelSettings)
 */
export async function generateHotelCheckInCredentials(reservation, business) {
  if (reservation.paymentStatus !== "paid") {
    throw new Error("Reservation payment status must be 'paid' to generate check-in credentials.");
  }

  const now = new Date();

  // 1. Calculate validity periods using business timezone
  const { checkInCodeValidFrom, checkInCodeExpiresAt } = getHotelCheckInWindow(reservation, business);

  // 2. Generate secure 6-digit code and hash it
  const plainCheckInCode = crypto.randomInt(100000, 1000000).toString();
  const checkInCodeHash = hashCheckInCode(plainCheckInCode);

  // 3. Update reservation with hashes, version bump, and tracking fields
  const updatedReservation = await Reservation.findOneAndUpdate(
    { _id: reservation._id },
    {
      $set: {
        checkInCodeHash,
        checkInCodeCreatedAt: now,
        checkInCodeValidFrom,
        checkInCodeExpiresAt,
        checkInCodeUsedAt: null, // Reset if regenerating
        checkInCodeLockedAt: null,
        checkInCodeFailedAttempts: 0,
      },
      $inc: { checkInCredentialVersion: 1 },
    },
    { new: true }
  );

  if (!updatedReservation) {
    throw new Error(`Failed to update reservation ${reservation._id} with new credentials.`);
  }

  // 4. Send Confirmation Email (contains the plain code)
  try {
    const result = await sendHotelPaymentConfirmationEmail({
      reservation: updatedReservation,
      business,
      plainCheckInCode,
      validFrom: checkInCodeValidFrom,
      expiresAt: checkInCodeExpiresAt,
    });

    // 5. Update email delivery success state
    await Reservation.updateOne(
      { _id: reservation._id },
      {
        $set: {
          confirmationEmailSentAt: new Date(),
          confirmationEmailMessageId: result?.messageId || "unknown",
          confirmationEmailError: null,
        },
      }
    );

    return { success: true, updatedReservation };
  } catch (err) {
    console.error(`[generateHotelCheckInCredentials] Email delivery failed for reservation ${reservation._id}:`, err);
    // Record email failure, but keep the generated hashes active for retry
    await Reservation.updateOne(
      { _id: reservation._id },
      {
        $set: {
          confirmationEmailError: err.message || "Unknown email delivery error",
        },
      }
    );

    throw err; // Let caller know email failed
  }
}
