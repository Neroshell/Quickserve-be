import Reservation from "../models/Reservation.js";
import Business from "../models/Business.js";
import ServicePoint from "../models/ServicePoint.js";
import crypto from "crypto";
import { sendReservationConfirmedEmail, sendReservationCancelledEmail, sendReservationPaymentEmail } from "../utils/emailService.js";
import { generateHotelCheckInCredentials } from "../services/hotelCheckInService.js";
import { CHECK_IN_CODE_PATTERN, normalizeCheckInCode, verifyCheckInCode } from "../utils/checkInCode.js";
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js";
import { ensureReservationPricingSnapshot } from "../services/reservationPricingService.js";
import { expireAwaitingPaymentReservations } from "../services/reservationExpiryService.js";
import {
  getRemainingRefundableAmountCents,
  getReservationCapturedAmountCents,
} from "../services/reservationCancellationService.js";
import { dispatchRestaurantReservationEmail } from "../services/email/emailDispatchService.js";
import {
  EMAIL_JOB_NAMES,
  enqueueReservationPaymentExpiry,
} from "../queues/index.js";
import { scheduleReservationArrivalReminder } from "../services/reservationArrivalService.js";

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
  confirmed: ["arrived", "cancelled", "no_show"],
  arrived: ["seated", "cancelled", "no_show"],
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

async function tryScheduleArrivalReminder(req, reservation, business) {
  const schedule = req.app?.locals?.scheduleReservationArrivalReminder ||
    scheduleReservationArrivalReminder;
  try {
    const result = await schedule({ reservation, business });
    return result?.queued ? "queued" : result?.reason || "not_scheduled";
  } catch (error) {
    console.error("[ReservationArrival] Reminder scheduling failed", {
      reservationId: String(reservation?._id || "unknown"),
      errorClass: error?.name || "Error",
      reason: error?.code || "schedule_failed",
    });
    return "schedule_failed";
  }
}

async function publishReservationEvent(...args) {
  const { publishEvent } = await import("../utils/sseManager.js");
  return publishEvent(...args);
}

export function getHotelPaymentExpiresAt(now = Date.now()) {
  return new Date(now + HOTEL_PAYMENT_WINDOW_MINUTES * 60 * 1000);
}

export function toOwnerReservationResponse(reservation) {
  const source = reservation?.toObject
    ? reservation.toObject()
    : { ...(reservation || {}) };
  const {
    secureToken,
    activeRefundId,
    arrivalTokenHash,
    arrivalIp,
    arrivalUserAgent,
    ...safeReservation
  } = source;
  const originalPaidAmountCents =
    getReservationCapturedAmountCents(safeReservation);
  const refundedAmountCents = Number(
    safeReservation.refundedAmountCents || 0,
  );
  const canUsePaymentLink =
    safeReservation.status === "accepted_awaiting_payment" &&
    safeReservation.paymentStatus !== "paid" &&
    secureToken;

  return {
    ...safeReservation,
    paymentUrl: canUsePaymentLink
      ? `${process.env.FRONTEND_BASE_URL || "https://quickservehq.com"}/reservation/pay/${secureToken}`
      : null,
    originalPaidAmountCents,
    refundedAmountCents,
    remainingRefundableAmountCents:
      getRemainingRefundableAmountCents({
        capturedAmountCents: originalPaidAmountCents,
        successfulRefundedAmountCents: refundedAmountCents,
      }),
    refundPending: Boolean(activeRefundId),
  };
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

    // Keep the owner view synchronized with the same persisted expiry state as
    // the scheduled job, without client-side polling or duplicate UI state.
    await expireAwaitingPaymentReservations({ businessId });

    // Optional filtering by status, date, etc.
    const { status, date } = req.query;
    const query = { businessId, archivedAt: null };
    if (status) query.status = status;
    if (date) query.date = date;

    const reservations = await Reservation.find(query).sort({ date: 1, time: 1 }).lean();
    
    res.json(reservations.map(toOwnerReservationResponse));
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
    if (status === "arrived") {
      return res.status(400).json({
        error: "Guest arrival must use the secure arrival check-in link.",
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
    const validStatuses = ["pending", "confirmed", "arrived", "cancelled", "seated", "completed", "no_show",
      "accepted_awaiting_payment", "expired", "checked_out"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Conflict check when confirming (restaurant/café only — hotels use date-overlap via accepted_awaiting_payment)
    const isHotel = resolveBusinessCapabilities(business).reservations.primaryMode === "stay";
    if (reservation.activeRefundId) {
      return res.status(409).json({
        error: "A refund operation is currently in progress for this reservation.",
      });
    }
    if (
      isHotel &&
      status === "cancelled" &&
      ["paid", "partially_refunded", "refunded"].includes(
        reservation.paymentStatus,
      )
    ) {
      return res.status(409).json({
        error: "Use the explicit cancellation workflow to decide how the payment should be handled.",
      });
    }
    const previousStatus = reservation.status;
    if (previousStatus === status) {
      const arrivalReminderStatus = status === "confirmed" && !isHotel
        ? await tryScheduleArrivalReminder(req, reservation, business)
        : "not_scheduled";
      return res.json({
        reservation: toOwnerReservationResponse(reservation),
        emailStatus: "not_sent",
        arrivalReminderStatus,
      });
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
            status: { $in: ["confirmed", "arrived", "seated"] },
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
      const scheduleExpiry =
        req.app?.locals?.enqueueReservationPaymentExpiry ||
        enqueueReservationPaymentExpiry;
      try {
        await scheduleExpiry({
          businessId: reservation.businessId,
          reservationId: reservation._id,
          expectedPaymentExpiry: reservation.paymentExpiresAt,
        });
      } catch (error) {
        // The recurring repair scan and retained cron endpoint remain the
        // recovery path if Redis is unavailable after the durable acceptance.
        console.error("[Reservation] Failed to enqueue payment expiry", {
          businessId: reservation.businessId,
          reservationId: String(reservation._id),
          reason: error?.code || error?.name || "enqueue_failed",
        });
      }
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
          activeRefundId: null,
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
    let arrivalReminderStatus = "not_scheduled";

    if (statusChanged) {
      console.log("[Reservation] Status change:", previousStatus, "->", status);
      
      const reservationObj = reservation.toObject();

      if (status === "confirmed" && !isHotel) {
        arrivalReminderStatus = await tryScheduleArrivalReminder(
          req,
          reservation,
          business,
        );
      }

      if (status === "seated" && !isHotel) {
        const emit = req.app?.locals?.publishEvent || publishReservationEvent;
        try {
          await emit(
            "reservation_seated",
            reservation.businessId,
            ["reservations"],
            {
              reservation: {
                id: String(reservation._id),
                status: reservation.status,
                customerName: reservation.customerName,
                guestCount: reservation.guestCount,
                date: reservation.date,
                startTime: reservation.startTime,
                endTime: reservation.endTime,
                servicePointLabel: reservation.servicePointLabel || null,
              },
            },
          );
        } catch (error) {
          console.error("[Reservation] Seated SSE publish failed", {
            reservationId: String(reservation._id),
            errorClass: error?.name || "Error",
          });
        }
      }

      if (!reservationObj.email) {
        console.log("Reservation status changed without an email recipient", {
          reservationId: String(reservationObj._id),
          businessId: reservationObj.businessId,
          status: reservationObj.status,
        });
      } else if (["confirmed", "cancelled", "declined", "accepted_awaiting_payment"].includes(status)) {
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
            const isRestaurantStatusEmail =
              !reservationObj.checkInDate &&
              ["confirmed", "cancelled", "declined"].includes(status);
            if (isRestaurantStatusEmail) {
              const jobName = status === "confirmed"
                ? EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED
                : EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED;
              const dispatch = await dispatchRestaurantReservationEmail({
                jobName,
                businessId: reservationObj.businessId,
                reservationId: reservationObj._id,
                deliveryVersion:
                  status === "confirmed"
                    ? reservationObj.confirmedAt || reservationObj.updatedAt
                    : reservationObj.cancelledAt || reservationObj.updatedAt,
                directSend: () => sender(emailArgs),
              });
              if (dispatch.mode === "queued") {
                emailStatus = dispatch.queued ? "queued" : "pending_retry";
              } else {
                emailStatus = dispatch.success ? "sent" : "failed";
              }
            } else {
              // Payment-link and all lodging emails remain synchronous because
              // they may contain one-time reservation credentials.
              const success = await sender(emailArgs);
              emailStatus = success ? "sent" : "failed";
            }
          } catch (emailError) {
            console.error(`[Reservation Email] ${status} delivery failed`, {
              reservationId: String(reservationObj._id),
              reason: emailError?.code || emailError?.name || "email_failed",
            });
            emailStatus = "failed";
          }
        }
      }
    }

    res.json({
      reservation: toOwnerReservationResponse(reservation),
      emailStatus,
      arrivalReminderStatus,
    });
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
    if (reservation.activeRefundId) {
      return res.status(409).json({
        error: "Check-in is unavailable while a refund operation is in progress.",
      });
    }

    if (!reservation.checkInCodeHash || !reservation.checkInCodeValidFrom || !reservation.checkInCodeExpiresAt) {
      return res.status(409).json({
        error: "This reservation does not have an active check-in code. Resend the confirmation email to generate one.",
      });
    }

    if (reservation.checkInCodeLockedAt) {
      return res.status(423).json({
        code: "CHECK_IN_CODE_LOCKED",
        error: "This check-in code is locked. Resend the confirmation email to issue a new code.",
        checkInCodeLocked: true,
        lockedAt: reservation.checkInCodeLockedAt,
        attemptsRemaining: 0,
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
          code: "CHECK_IN_CODE_LOCKED",
          error: "Too many incorrect attempts. Resend the confirmation email to issue a new code.",
          checkInCodeLocked: true,
          lockedAt: now,
          attemptsRemaining: 0,
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
        activeRefundId: null,
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
    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const reservation = await Reservation.findOne(scope);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const business = await Business.findOne({
      businessId: reservation.businessId,
    }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    if (!reservation.checkInDate) {
      return res.status(400).json({ error: "Only hotel reservations are eligible for check-in codes" });
    }

    if (reservation.paymentStatus !== "paid" || reservation.status !== "confirmed") {
      return res.status(409).json({ error: "Reservation must be paid and confirmed" });
    }
    if (reservation.activeRefundId) {
      return res.status(409).json({
        error: "A new check-in code cannot be sent while a refund operation is in progress.",
      });
    }

    try {
      const { updatedReservation } = await generateHotelCheckInCredentials(
        reservation,
        business,
      );
      const resentAt = new Date();
      const actor = buildReservationStaffSnapshot(req.session?.user);
      const auditedReservation = await Reservation.findOneAndUpdate(
        {
          _id: updatedReservation._id,
          businessId: reservation.businessId,
        },
        {
          $set: {
            confirmationEmailResentAt: resentAt,
            ...(actor ? { confirmationEmailResentBy: actor } : {}),
          },
          $inc: { confirmationEmailSendCount: 1 },
        },
        { new: true, runValidators: true },
      );

      return res.json({
        message: "A new check-in code was sent to the guest.",
        reservation: toOwnerReservationResponse(
          auditedReservation || updatedReservation,
        ),
      });
    } catch (emailErr) {
      console.error("[reservationController.resendReservationConfirmation] Email failed:", emailErr);
      // Keep the modal in its safe locked state when the provider does not
      // accept the replacement-code email.
      await Reservation.updateOne(
        {
          _id: reservation._id,
          businessId: reservation.businessId,
          status: "confirmed",
          paymentStatus: "paid",
        },
        { $set: { checkInCodeLockedAt: new Date() } },
      );
      return res.status(500).json({ error: "Failed to send the email. Please check your provider settings." });
    }

  } catch (err) {
    console.error("[reservationController.resendReservationConfirmation] Error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * POST /owner/reservations/:id/resend-payment-link
 * Resend the existing, still-active payment link without extending its expiry.
 */
export async function resendReservationPaymentLink(req, res) {
  try {
    const { id } = req.params;
    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let reservation = await Reservation.findOne(scope);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const now = new Date();
    const expiry = reservation.paymentExpiresAt
      ? new Date(reservation.paymentExpiresAt)
      : null;
    if (
      reservation.status === "accepted_awaiting_payment" &&
      expiry &&
      expiry <= now
    ) {
      reservation = await Reservation.findOneAndUpdate(
        {
          ...scope,
          status: "accepted_awaiting_payment",
          paymentExpiresAt: { $lte: now },
        },
        { $set: { status: "expired" } },
        { new: true, runValidators: true },
      ) || reservation;

      return res.status(409).json({
        error: "This payment link has expired.",
        reservation: toOwnerReservationResponse(reservation),
      });
    }

    if (
      reservation.status !== "accepted_awaiting_payment" ||
      reservation.paymentStatus === "paid"
    ) {
      return res.status(409).json({
        error: "Only reservations awaiting payment have an active payment link.",
      });
    }

    if (!reservation.secureToken || !reservation.email || !expiry) {
      return res.status(409).json({
        error: "This reservation does not have an active payment link.",
      });
    }

    const business = await Business.findOne({
      businessId: reservation.businessId,
    }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const sent = await sendReservationPaymentEmail({
      to: reservation.email,
      businessName: business.displayName || business.name,
      businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
      primaryColor: business.branding?.primaryColor,
      reservation: reservation.toObject(),
    });
    if (!sent) {
      return res.status(500).json({
        error: "Failed to resend the payment link. Please check your provider settings.",
      });
    }

    return res.json({
      message: "Payment link resent successfully.",
      reservation: toOwnerReservationResponse(reservation),
    });
  } catch (error) {
    console.error(
      "[reservationController.resendReservationPaymentLink] Error:",
      error,
    );
    return res.status(500).json({ error: "Server error" });
  }
}

