import Reservation from "../models/Reservation.js";
import Business from "../models/Business.js";
import ServicePoint from "../models/ServicePoint.js";
import crypto from "crypto";
import { sendReservationConfirmedEmail, sendReservationCancelledEmail, sendReservationPaymentEmail } from "../utils/emailService.js";
import { generateHotelCheckInCredentials } from "../services/hotelCheckInService.js";
import { CHECK_IN_CODE_PATTERN, normalizeCheckInCode, verifyCheckInCode } from "../utils/checkInCode.js";
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js";
import { ensureReservationPricingSnapshot } from "../services/reservationPricingService.js";

const MAX_CHECK_IN_CODE_ATTEMPTS = 5;
export const HOTEL_PAYMENT_WINDOW_MINUTES = 30;
const ARCHIVABLE_RESERVATION_STATUSES = new Set([
  "cancelled",
  "declined",
  "expired",
  "no_show",
  "completed",
  "checked_out",
]);

const STAY_STATUS_TRANSITIONS = Object.freeze({
  pending: ["accepted_awaiting_payment", "confirmed", "cancelled", "expired"],
  pending_approval: ["accepted_awaiting_payment", "cancelled"],
  accepted_awaiting_payment: ["confirmed", "cancelled", "expired"],
  confirmed: ["cancelled"],
  checked_in: ["checked_out", "cancelled"],
  checked_out: [],
  completed: [],
  cancelled: [],
  expired: [],
});

const TIMESLOT_STATUS_TRANSITIONS = Object.freeze({
  pending: ["confirmed", "cancelled", "no_show"],
  confirmed: ["seated", "completed", "cancelled", "no_show"],
  seated: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
});

export function buildReservationStaffSnapshot(user) {
  if (!user) return null;
  const userId = user.userId || user.staffId || user.id || null;
  const name = user.name || null;
  const email = user.email || null;
  const role = user.role || null;
  if (!userId && !name && !email && !role) return null;
  return { userId, name, email, role };
}

export function isReservationStatusTransitionAllowed({
  currentStatus,
  nextStatus,
  isStay,
}) {
  if (currentStatus === nextStatus) return true;
  const transitions = isStay
    ? STAY_STATUS_TRANSITIONS
    : TIMESLOT_STATUS_TRANSITIONS;
  return (transitions[currentStatus] || []).includes(nextStatus);
}

function reservationScope(req, id) {
  const sessionUser = req.session?.user;
  if (sessionUser?.role === "admin") return { _id: id };
  if (!sessionUser?.businessId) return null;
  return {
    _id: id,
    businessId: sessionUser.businessId,
  };
}

function normalizeCancellationReason(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function getHotelPaymentExpiresAt(now = Date.now()) {
  return new Date(now + HOTEL_PAYMENT_WINDOW_MINUTES * 60 * 1000);
}

/**
 * Get reservations for a specific business (Owner authenticated)
 * GET /owner/reservations?businessId=...
 */
export async function getReservations(req, res) {
  try {
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" });
    }

    // Ensure the business belongs to this owner
    const business = await Business.findOne({ businessId, ownerEmail: req.session.user.email }).lean();
    if (!business && req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    // Optional filtering by status, date, etc.
    const { status, date } = req.query;
    const query = { businessId, archivedAt: null };
    if (status) query.status = status;
    if (date) query.date = date;

    const reservations = await Reservation.find(query).sort({ date: 1, time: 1 }).lean();
    
    res.json(reservations);
  } catch (error) {
    console.error("[reservationController.getReservations] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Update reservation status (Owner authenticated)
 * PATCH /owner/reservations/:id/status
 */
export async function updateReservationStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, cancellationReason } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (status === "checked_in") {
      return res.status(400).json({
        error: "Use the reservation check-in action and provide the guest's check-in code.",
      });
    }

    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let reservation = await Reservation.findOne(scope);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    // Load the business (unscoped) so branding is available for emails and the
    // operating-hours check below works for admins too.
    const business = await Business.findOne({ businessId: reservation.businessId }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    // Basic status validation
    const validStatuses = ["pending", "confirmed", "cancelled", "seated", "completed", "no_show",
      "accepted_awaiting_payment", "expired", "checked_out"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Conflict check when confirming (restaurant/café only — hotels use date-overlap via accepted_awaiting_payment)
    const isHotel = resolveBusinessCapabilities(business).reservations.primaryMode === "stay";
    const previousStatus = reservation.status;
    if (previousStatus === status) {
      return res.json({ reservation, emailStatus: "not_sent" });
    }
    if (!isReservationStatusTransitionAllowed({
      currentStatus: previousStatus,
      nextStatus: status,
      isStay: isHotel,
    })) {
      return res.status(409).json({
        error: `Invalid reservation transition: ${previousStatus} -> ${status}`,
      });
    }
    if (status === "confirmed" && !isHotel) {
      // Operating hours validation
      const [year, month, day] = (reservation.date || "").split("-").map(Number);
      if (year && month && day) {
        const dayOfWeek = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long' });
        const dayConfig = business.operatingHours?.[dayOfWeek];

        if (!dayConfig || !dayConfig.enabled || reservation.startTime < dayConfig.openTime || reservation.endTime > dayConfig.closeTime) {
          return res.status(400).json({ error: "Reservations are only available during business hours." });
        }

        if (reservation.servicePointId) {
          const existingReservation = await Reservation.findOne({
            businessId: reservation.businessId,
            servicePointId: reservation.servicePointId,
            date: reservation.date,
            status: "confirmed",
            startTime: { $lt: reservation.endTime },
            endTime: { $gt: reservation.startTime },
            _id: { $ne: reservation._id }
          }).lean();

          if (existingReservation) {
            return res.status(409).json({ error: "This place is already booked and confirmed for the selected time." });
          }
        }
      }
    }

    if (status === "accepted_awaiting_payment") {
      await ensureReservationPricingSnapshot({
        reservation,
        business,
        save: false,
      });
      reservation.secureToken = crypto.randomBytes(32).toString("hex");
      reservation.paymentExpiresAt = getHotelPaymentExpiresAt();
      reservation.status = status;
      await reservation.save();
    } else {
      const now = new Date();
      const actor = buildReservationStaffSnapshot(req.session?.user);
      const fields = { status };

      if (status === "confirmed" && !reservation.confirmedAt) {
        fields.confirmedAt = now;
        if (actor) fields.confirmedBy = actor;
      }
      if (status === "cancelled" && !reservation.cancelledAt) {
        fields.cancelledAt = now;
        fields.cancellationReason =
          normalizeCancellationReason(cancellationReason);
        if (actor) {
          fields.cancelledBy = {
            actorType:
              req.session?.user?.role === "admin"
                ? "admin"
                : "staff",
            ...actor,
          };
        }
      }
      if (status === "checked_out" && !reservation.checkedOutAt) {
        fields.checkedOutAt = now;
        if (actor) fields.checkedOutBy = actor;
      }

      reservation = await Reservation.findOneAndUpdate(
        {
          ...scope,
          status: previousStatus,
        },
        { $set: fields },
        { new: true, runValidators: true }
      );
      if (!reservation) {
        return res.status(409).json({
          error: "The reservation was updated elsewhere. Refresh and try again.",
        });
      }
    }

    const statusChanged = previousStatus !== status;
    let emailStatus = "not_sent";

    if (statusChanged) {
      console.log("[Reservation] Status change:", previousStatus, "->", status);
      
      const reservationObj = reservation.toObject();

      if (!reservationObj.email) {
        console.log("Reservation status changed but no customer email found in DB.", reservationObj);
      } else if (status === "confirmed" || status === "cancelled" || status === "accepted_awaiting_payment") {
        console.log("[Reservation Email] Customer email:", reservationObj.email);
        console.log(`[Reservation Email] Sending ${status} email`);

        const emailArgs = {
          to: reservationObj.email,
          businessName: business.displayName || business.name,
          businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
          primaryColor: business.branding?.primaryColor,
          reservation: reservationObj,
        };

        let sender;
        if (status === "confirmed") sender = sendReservationConfirmedEmail;
        else if (status === "cancelled" || status === "declined") sender = sendReservationCancelledEmail;
        else if (status === "accepted_awaiting_payment") sender = sendReservationPaymentEmail;

        if (sender) {
          try {
            console.log("[Reservation Email] Awaiting sender...");
            const success = await sender(emailArgs);
            console.log(`[Reservation Email] Sender returned:`, success);
            if (!success) {
              emailStatus = "failed";
              console.error(`[Reservation Email] Failed to send ${status} email (sender returned false)`);
            } else {
              emailStatus = "sent";
              console.log(`[Reservation Email] Successfully sent ${status} email`);
            }
          } catch (emailError) {
            console.error(`[Reservation Email] Exception in sender for ${status} email:`, emailError);
            emailStatus = "failed";
          }
        }
      }
    }

    res.json({ reservation, emailStatus });
  } catch (error) {
    console.error("[reservationController.updateReservationStatus] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Check in a paid, confirmed hotel guest using the code from their confirmation email.
 * POST /owner/reservations/:id/check-in
 */
export async function checkInHotelReservation(req, res) {
  try {
    const { id } = req.params;
    const code = normalizeCheckInCode(req.body?.code);
    const sessionUser = req.session?.user;

    if (!CHECK_IN_CODE_PATTERN.test(code)) {
      return res.status(400).json({ error: "A valid 6-digit check-in code is required." });
    }

    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const reservation = await Reservation.findOne(scope).select("+checkInCodeHash");
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    if (!reservation.checkInDate) {
      return res.status(400).json({ error: "Only hotel reservations can be checked in with a code." });
    }

    if (reservation.status === "checked_in" || reservation.checkInCodeUsedAt) {
      return res.status(409).json({ error: "This guest is already checked in." });
    }

    if (reservation.status !== "confirmed" || reservation.paymentStatus !== "paid") {
      return res.status(409).json({ error: "Only paid, confirmed reservations can be checked in." });
    }

    if (!reservation.checkInCodeHash || !reservation.checkInCodeValidFrom || !reservation.checkInCodeExpiresAt) {
      return res.status(409).json({
        error: "This reservation does not have an active check-in code. Resend the confirmation email to generate one.",
      });
    }

    if (reservation.checkInCodeLockedAt) {
      return res.status(423).json({
        error: "This check-in code is locked. Resend the confirmation email to issue a new code.",
      });
    }

    const now = new Date();
    if (now < reservation.checkInCodeValidFrom) {
      return res.status(409).json({
        error: "This check-in code is not active yet.",
        validFrom: reservation.checkInCodeValidFrom,
      });
    }

    if (now > reservation.checkInCodeExpiresAt) {
      return res.status(410).json({ error: "This check-in code has expired." });
    }

    if (!verifyCheckInCode(code, reservation.checkInCodeHash)) {
      const failedAttempts = (reservation.checkInCodeFailedAttempts || 0) + 1;
      const shouldLock = failedAttempts >= MAX_CHECK_IN_CODE_ATTEMPTS;
      await Reservation.updateOne(
        { _id: reservation._id, checkInCodeUsedAt: null },
        {
          $set: {
            checkInCodeFailedAttempts: failedAttempts,
            ...(shouldLock ? { checkInCodeLockedAt: now } : {}),
          },
        }
      );

      if (shouldLock) {
        return res.status(423).json({
          error: "Too many incorrect attempts. Resend the confirmation email to issue a new code.",
        });
      }

      return res.status(401).json({
        error: "Incorrect check-in code.",
        attemptsRemaining: MAX_CHECK_IN_CODE_ATTEMPTS - failedAttempts,
      });
    }

    const updatedReservation = await Reservation.findOneAndUpdate(
      {
        _id: reservation._id,
        businessId: reservation.businessId,
        status: "confirmed",
        checkInCodeUsedAt: null,
        checkInCodeLockedAt: null,
      },
      {
        $set: {
          status: "checked_in",
          checkInCodeUsedAt: now,
          checkedInAt: now,
          checkedInBy: {
            userId: sessionUser?.userId || sessionUser?.staffId || null,
            name: sessionUser?.name || null,
            email: sessionUser?.email || null,
            role: sessionUser?.role || null,
          },
        },
      },
      { new: true, runValidators: true }
    );

    if (!updatedReservation) {
      return res.status(409).json({ error: "The reservation could not be checked in because it was updated elsewhere." });
    }

    return res.json({
      message: "Guest checked in successfully.",
      reservation: updatedReservation,
    });
  } catch (error) {
    console.error("[reservationController.checkInHotelReservation] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * DELETE /owner/reservations/:id
 */
export async function deleteReservation(req, res) {
  try {
    const { id } = req.params;
    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const reservation = await Reservation.findOne(scope);
    
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    if (!ARCHIVABLE_RESERVATION_STATUSES.has(reservation.status)) {
      return res.status(409).json({
        error: "Only terminal reservations can be removed. Cancel the reservation first.",
      });
    }

    if (!reservation.archivedAt) {
      const actor = buildReservationStaffSnapshot(req.session?.user);
      const fields = { archivedAt: new Date() };
      if (actor) fields.archivedBy = actor;

      await Reservation.findOneAndUpdate(
        { ...scope, archivedAt: null },
        { $set: fields },
        { new: true, runValidators: true }
      );
    }

    res.json({ message: "Reservation removed from operational views" });
  } catch (error) {
    console.error("[reservationController.deleteReservation] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/available-rooms
 * Fetch ServicePoints available for a stay based on check-in and check-out dates.
 * The legacy URL is retained for compatibility.
 */
export async function getAvailableStayServicePoints(req, res) {
  try {
    const { businessSlug, checkInDate, checkOutDate, guestCount } = req.query;

    if (!businessSlug || !checkInDate || !checkOutDate) {
      return res.status(400).json({ error: "businessSlug, checkInDate, and checkOutDate are required" });
    }

    const business = await Business.findOne({ slug: businessSlug.toLowerCase() }).lean();
    if (!business || !resolveBusinessCapabilities(business).reservations.modes.includes("stay")) {
      return res.status(404).json({ error: "Hotel not found" });
    }

    if (business.settings?.reservationsEnabled === false) {
      return res.status(403).json({ error: "Reservations are disabled." });
    }

    // A ServicePoint is unavailable when the requested stay overlaps an
    // existing blocking reservation.
    const overlappingReservations = await Reservation.find({
      businessId: business.businessId,
      status: { $in: ["accepted_awaiting_payment", "confirmed", "checked_in"] }, // blocking statuses
      checkInDate: { $lt: checkOutDate },
      checkOutDate: { $gt: checkInDate }
    }).lean();

    const unavailableServicePointIds = overlappingReservations
      .map((reservation) => reservation.servicePointId)
      .filter(Boolean);

    let servicePoints = await ServicePoint.find({
      businessId: business.businessId,
      isActive: true,
      reservable: true
    }).lean();

    // Filter by capacity if guestCount is provided
    if (guestCount) {
      const parsedGuestCount = parseInt(guestCount, 10);
      if (!isNaN(parsedGuestCount)) {
        servicePoints = servicePoints.filter(
          (servicePoint) => !servicePoint.capacity || servicePoint.capacity >= parsedGuestCount
        );
      }
    }

    const availableServicePoints = servicePoints.filter(
      (servicePoint) => !unavailableServicePointIds.includes(servicePoint.servicePointId)
    );

    res.json(availableServicePoints);
  } catch (error) {
    console.error("[reservationController.getAvailableStayServicePoints] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * POST /owner/reservations/:id/resend-confirmation
 * Resend the hotel payment confirmation email with a new check-in code
 */
export async function resendReservationConfirmation(req, res) {
  try {
    const { id } = req.params;
    
    // Find the reservation
    const reservation = await Reservation.findById(id);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    // Ensure it belongs to the authenticated owner's business
    const business = await Business.findOne({ businessId: reservation.businessId, ownerEmail: req.session.user.email }).lean();
    if (!business && req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    // Must be a hotel check-in
    if (!reservation.checkInDate) {
      return res.status(400).json({ error: "Only hotel reservations are eligible for check-in codes" });
    }

    // Must be paid and confirmed
    if (reservation.paymentStatus !== "paid" || reservation.status === "cancelled") {
      return res.status(400).json({ error: "Reservation must be paid and not cancelled" });
    }

    // Generate new credentials and resend email
    try {
      await generateHotelCheckInCredentials(reservation, business);
      
      // Update resend tracking
      await Reservation.updateOne(
        { _id: reservation._id },
        { 
          $set: { confirmationEmailResentAt: new Date() },
          $inc: { confirmationEmailSendCount: 1 } 
        }
      );

      return res.json({ message: "Confirmation email resent successfully." });
    } catch (emailErr) {
      console.error("[reservationController.resendReservationConfirmation] Email failed:", emailErr);
      return res.status(500).json({ error: "Failed to send the email. Please check your provider settings." });
    }

  } catch (err) {
    console.error("[reservationController.resendReservationConfirmation] Error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

