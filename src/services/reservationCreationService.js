import mongoose from "mongoose";
import { DateTime } from "luxon";
import Business from "../models/Business.js";
import Reservation, { timeStringToMinutes, MIN_DURATION_MINUTES } from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import { getCustomerReservationPricing, buildReservationPricingSnapshot } from "./reservationPricingService.js";
import { sendReservationRequestEmail, sendReservationRequestReceivedEmail } from "../utils/emailService.js";
import { dispatchRestaurantReservationEmail } from "./email/emailDispatchService.js";
import { validateReservationGuestCapacity } from "./reservationCapacityService.js";
import { EMAIL_JOB_NAMES } from "../queues/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE C — Business-timezone date helper
// Returns the business-local calendar date as a "YYYY-MM-DD" string.
// Never use new Date().toISOString().split("T")[0] for hotel date checks.
// ─────────────────────────────────────────────────────────────────────────────
function getBusinessLocalDate(business) {
  const tz = business.timezone || "UTC";
  return DateTime.now().setZone(tz).toISODate(); // "YYYY-MM-DD"
}

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY-BLOCKING STATUSES
// Any reservation in these statuses blocks the room for its date range.
// Must stay in sync with conflict checks everywhere.
// ─────────────────────────────────────────────────────────────────────────────
export const BLOCKING_STAY_STATUSES = Object.freeze([
  "pending",
  "accepted_awaiting_payment",
  "confirmed",
  "checked_in",
]);

/**
 * Validates that a servicePoint is a reservable room belonging to the business.
 * Returns the servicePoint document or throws a statusCode-annotated error.
 */
export async function resolveHotelRoom({ servicePointId, businessId, session } = {}) {
  const sp = await ServicePoint.findOne({
    servicePointId,
    businessId,
    isActive: { $ne: false },
    reservable: { $ne: false },
  })
    .session(session ?? null)
    .lean();

  if (!sp) {
    const err = new Error("The selected room is not available for booking.");
    err.statusCode = 400;
    throw err;
  }

  // Phase I rule 5: servicePointType must be room
  if (sp.servicePointType && sp.servicePointType !== "room") {
    const err = new Error(
      `The selected service point is of type "${sp.servicePointType}", not a room.`,
    );
    err.statusCode = 400;
    throw err;
  }

  return sp;
}

/**
 * Checks for overlapping blocking reservations for the given room and date range.
 * Must be called inside a MongoDB session for concurrency safety.
 * Throws a 409 if a conflict is found.
 */
export async function assertNoRoomConflict({
  businessId,
  servicePointId,
  checkInDate,
  checkOutDate,
  excludeReservationId = null,
  session,
}) {
  const query = {
    businessId,
    servicePointId,
    status: { $in: [...BLOCKING_STAY_STATUSES] },
    checkInDate: { $lt: checkOutDate },
    checkOutDate: { $gt: checkInDate },
  };

  if (excludeReservationId) {
    query._id = { $ne: excludeReservationId };
  }

  const conflict = await Reservation.findOne(query)
    .session(session ?? null)
    .lean();

  if (conflict) {
    const err = new Error("This room is already booked for the selected dates.");
    err.statusCode = 409;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL BOOKING — canonical creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a hotel (stay) reservation.
 *
 * For public online bookings:
 *   source = "online"  (or legacy "public_hub")
 *   status = "pending"
 *   paymentChannel = null
 *
 * For staff walk-in bookings:
 *   source = "walk_in"
 *   paymentStatus = "paid"
 *   paymentChannel = "offline"
 *   paidVia = "cash" | "pos_card"
 *   status = "confirmed" (or "checked_in" when checkInNow=true)
 *   createdBy = staff snapshot
 *
 * @param {Object} options
 * @param {Object} options.business - Full business document (.lean())
 * @param {string} options.customerName
 * @param {string} options.phone
 * @param {string} options.email
 * @param {string} options.checkInDate  - "YYYY-MM-DD"
 * @param {string} options.checkOutDate - "YYYY-MM-DD"
 * @param {number} options.guestCount
 * @param {string} options.servicePointId
 * @param {string} [options.specialRequest]
 * @param {string} [options.source="public_hub"] - "online" | "walk_in" | "public_hub" | "dashboard"
 * @param {string} [options.paymentMethod] - "cash" | "pos_card" — required for walk_in
 * @param {boolean} [options.checkInNow=false] - If true and today, transitions to checked_in
 * @param {Object} [options.staffSnapshot] - Pre-built staff snapshot for createdBy/checkedInBy
 * @returns {Promise<{message, reservationId, reservation, pricing}>}
 */
export async function createHotelReservation({
  business,
  customerName,
  phone,
  email,
  checkInDate,
  checkOutDate,
  guestCount,
  servicePointId,
  specialRequest,
  source = "public_hub",
  paymentMethod = null,
  checkInNow = false,
  staffSnapshot = null,
}) {
  // ── Phase I: Validation ──────────────────────────────────────────────────

  if (!customerName || !phone || !email || !checkInDate || !checkOutDate || !guestCount || !servicePointId) {
    const err = new Error("Missing required fields.");
    err.statusCode = 400;
    throw err;
  }

  // Phase C: Use business-local date for "today"
  const businessToday = getBusinessLocalDate(business);

  if (checkInDate < businessToday) {
    const err = new Error("Check-in date cannot be in the past.");
    err.statusCode = 400;
    throw err;
  }

  if (checkOutDate <= checkInDate) {
    const err = new Error("Check-out must be after check-in.");
    err.statusCode = 400;
    throw err;
  }

  const guests = parseInt(guestCount, 10);
  if (isNaN(guests) || guests < 1 || guests > 50) {
    const err = new Error("Guest count must be between 1 and 50.");
    err.statusCode = 400;
    throw err;
  }

  if (specialRequest && specialRequest.length > 500) {
    const err = new Error("Special request is too long (max 500 characters).");
    err.statusCode = 400;
    throw err;
  }

  // Phase I rule 10: Walk-in payment method validation
  const isWalkIn = source === "walk_in";
  if (isWalkIn) {
    const VALID_WALK_IN_PAYMENT = ["cash", "pos_card"];
    if (!paymentMethod || !VALID_WALK_IN_PAYMENT.includes(paymentMethod)) {
      const err = new Error(
        'Walk-in payment method must be "cash" or "pos_card".',
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const session = await mongoose.startSession();
  let hotelReservation;

  try {
    await session.withTransaction(async () => {
      // Phase I rules 4–8 inside transaction for concurrency safety
      const sp = await resolveHotelRoom({
        servicePointId,
        businessId: business.businessId,
        session,
      });

      // Phase I rule 7: capacity check
      if (sp.capacity != null && guests > sp.capacity) {
        const err = new Error(
          `This room accommodates a maximum of ${sp.capacity} guests.`,
        );
        err.statusCode = 400;
        throw err;
      }

      // Phase B/I rule 8: atomic conflict check
      await assertNoRoomConflict({
        businessId: business.businessId,
        servicePointId,
        checkInDate,
        checkOutDate,
        session,
      });

      const msPerDay = 1000 * 60 * 60 * 24;
      const numberOfNights = Math.round(
        (new Date(checkOutDate) - new Date(checkInDate)) / msPerDay,
      );
      const pricePerNight = sp.pricePerNight || 0;

      const now = new Date();

      // ── Phase I rule 12: Derive status and payment fields server-side ────
      let reservationStatus = "pending";
      let paymentStatus = "pending";
      let paymentChannel = null;
      let paidVia = null;
      let paidAt = null;
      let confirmedAt = null;
      let confirmedBy = null;
      let checkedInAt = null;
      let checkedInBy = null;
      let amountPaidCents = undefined;

      if (isWalkIn) {
        // Walk-ins are always paid immediately
        reservationStatus = "confirmed";
        paymentStatus = "paid";
        paymentChannel = "offline";
        paidVia = paymentMethod; // "cash" or "pos_card"
        paidAt = now;
        confirmedAt = now;
        confirmedBy = staffSnapshot;

        // Phase J/K: Check-in immediately only when check-in date is today
        // AND checkInNow flag is explicitly set
        if (checkInNow && checkInDate === businessToday) {
          reservationStatus = "checked_in";
          checkedInAt = now;
          checkedInBy = staffSnapshot;
        }
      }

      hotelReservation = new Reservation({
        businessId: business.businessId,
        businessSlug: business.slug,
        customerName,
        phone,
        email,
        checkInDate,
        checkOutDate,
        guestCount: guests,
        servicePointId: sp.servicePointId,
        servicePointLabel: sp.displayLabel || sp.label,
        roomTypeSnapshot: sp.roomType || null,
        specialRequest,
        pricePerNight,
        numberOfNights,
        currency: business.currency || "eur",
        // Phase D: Canonical source value
        source,
        // Phase E: Staff attribution — only for staff-created reservations
        createdBy: staffSnapshot ?? null,
        // Phase I rule 12 derived fields:
        status: reservationStatus,
        paymentStatus,
        paymentChannel,
        paidVia,
        paidAt,
        confirmedAt,
        confirmedBy,
        checkedInAt,
        checkedInBy,
        ...(amountPaidCents != null ? { amountPaidCents } : {}),
      });

      // Phase G: Canonical pricing snapshot from existing pricing service
      try {
        const snapshot = await buildReservationPricingSnapshot({
          reservation: hotelReservation,
          business,
        });
        Object.assign(hotelReservation, snapshot);

        // For walk-ins, record the final amount paid in cents
        if (isWalkIn && hotelReservation.grossAmountCents) {
          hotelReservation.amountPaidCents = hotelReservation.grossAmountCents;
        }
      } catch (pricingErr) {
        console.error(
          "[createHotelReservation] Pricing snapshot failed:",
          pricingErr,
        );
        // Non-fatal: save without full snapshot, can be recomputed later
      }

      await hotelReservation.save({ session });
    });
  } finally {
    await session.endSession();
  }

  // ── Post-save: SSE notification ─────────────────────────────────────────
  try {
    const { publishEvent } = await import("../utils/sseManager.js");
    const eventName =
      hotelReservation.status === "checked_in"
        ? "reservation_checked_in"
        : "reservation_created";
    publishEvent(eventName, hotelReservation.businessId, ["reservations", "owner"], {
      reservation: {
        id: String(hotelReservation._id),
        status: hotelReservation.status,
        customerName: hotelReservation.customerName,
        guestCount: hotelReservation.guestCount,
        checkInDate: hotelReservation.checkInDate,
        checkOutDate: hotelReservation.checkOutDate,
        servicePointLabel: hotelReservation.servicePointLabel || null,
        source: hotelReservation.source,
        type: "hotel",
      },
    });
  } catch (err) {
    console.error("[createHotelReservation] SSE publish failed:", err);
  }

  // ── Post-save: Email notifications ───────────────────────────────────────
  const reservationObj = hotelReservation.toObject();
  const businessDisplayName = business.displayName || business.name;
  const targetEmail = business.contactEmail || business.ownerEmail;

  // For online (guest-initiated) bookings, notify the owner and guest.
  // Walk-in bookings don't use the public pending-request email.
  if (!isWalkIn) {
    if (targetEmail) {
      sendReservationRequestEmail({
        to: targetEmail,
        businessName: businessDisplayName,
        reservation: reservationObj,
      }).catch((err) =>
        console.error("[createHotelReservation] Owner email failed:", err),
      );
    }
    if (reservationObj.email) {
      sendReservationRequestReceivedEmail({
        to: reservationObj.email,
        businessName: businessDisplayName,
        businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
        primaryColor: business.branding?.primaryColor,
        reservation: reservationObj,
      }).catch((err) =>
        console.error("[createHotelReservation] Customer email failed:", err),
      );
    }
  }

  return {
    message: isWalkIn
      ? hotelReservation.status === "checked_in"
        ? "Walk-in booked and guest checked in."
        : "Walk-in booking confirmed and paid."
      : "Hotel booking request received.",
    reservationId: hotelReservation._id,
    pricing: getCustomerReservationPricing(hotelReservation),
    reservation: hotelReservation.toObject(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTAURANT / BAR BOOKING — unchanged from prior refactor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a restaurant timeslot reservation.
 * Called by both the public API and (rarely) the owner dashboard.
 */
export async function createRestaurantReservation({
  businessSlug,
  customerName,
  phone,
  email,
  date,
  startTime,
  endTime,
  durationMinutes,
  guestCount,
  seatingPreference,
  servicePointId,
  servicePointLabel,
  specialRequest,
  source = "public_hub",
  overrides = {},
}) {
  if (!businessSlug || !customerName || !phone || !email || !date || !startTime || !endTime || !guestCount) {
    const err = new Error("Missing required fields");
    err.statusCode = 400;
    throw err;
  }

  const startMinutes = timeStringToMinutes(startTime);
  const endMinutes = timeStringToMinutes(endTime);
  if (Number.isNaN(startMinutes) || Number.isNaN(endMinutes)) {
    const err = new Error("startTime and endTime must be valid HH:MM values");
    err.statusCode = 400;
    throw err;
  }
  if (endMinutes <= startMinutes) {
    const err = new Error("End time must be after start time");
    err.statusCode = 400;
    throw err;
  }

  const duration = endMinutes - startMinutes;
  if (durationMinutes != null && Number(durationMinutes) !== duration) {
    const err = new Error("durationMinutes does not match the start/end time range");
    err.statusCode = 400;
    throw err;
  }
  if (duration < MIN_DURATION_MINUTES) {
    const err = new Error("Duration must be at least 30 minutes");
    err.statusCode = 400;
    throw err;
  }

  const guests = parseInt(guestCount, 10);
  if (isNaN(guests) || guests < 1 || guests > 50) {
    const err = new Error("Guest count must be between 1 and 50");
    err.statusCode = 400;
    throw err;
  }

  if (specialRequest && specialRequest.length > 500) {
    const err = new Error("Special request is too long (max 500 characters)");
    err.statusCode = 400;
    throw err;
  }

  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = startTime.split(":").map(Number);

  if (!year || isNaN(month) || isNaN(day) || isNaN(hours) || isNaN(minutes)) {
    const err = new Error("Invalid date or time format");
    err.statusCode = 400;
    throw err;
  }

  const reservationDate = new Date(year, month - 1, day, hours, minutes);
  if (reservationDate < new Date()) {
    const err = new Error("Reservation cannot be in the past");
    err.statusCode = 400;
    throw err;
  }

  const business = await Business.findOne({
    slug: businessSlug.toLowerCase(),
    status: { $in: ["active", "onboarding", "draft"] },
  }).lean();
  if (!business) {
    const err = new Error("Business not found or inactive");
    err.statusCode = 404;
    throw err;
  }

  if (business.settings?.reservationsEnabled === false) {
    const err = new Error("Reservations are currently disabled for this business.");
    err.statusCode = 403;
    throw err;
  }

  const dayOfWeek = new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "long" });
  const dayConfig = business.operatingHours?.[dayOfWeek];
  if (!dayConfig || !dayConfig.enabled) {
    const err = new Error("Reservations are only available during business hours.");
    err.statusCode = 400;
    throw err;
  }
  if (startTime < dayConfig.openTime || endTime > dayConfig.closeTime) {
    const err = new Error("Reservations are only available during business hours.");
    err.statusCode = 400;
    throw err;
  }

  let reservation;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      let capacityServicePoints;
      if (servicePointId) {
        const sp = await ServicePoint.findOne({
          servicePointId,
          businessId: business.businessId,
          isActive: { $ne: false },
          reservable: { $ne: false },
        })
          .session(session)
          .lean();
        if (!sp) {
          const err = new Error("The selected service point is not available for reservations.");
          err.statusCode = 400;
          throw err;
        }

        capacityServicePoints = [sp];
        const { capacity, valid } = validateReservationGuestCapacity({
          guestCount: guests,
          servicePoints: capacityServicePoints,
          servicePointId,
        });
        if (!valid) {
          const err = new Error(
            "This service point accommodates a maximum of " + capacity + " guests.",
          );
          err.statusCode = 400;
          throw err;
        }

        const existingReservation = await Reservation.findOne({
          businessId: business.businessId,
          servicePointId,
          date,
          status: { $in: ["confirmed", "arrived"] },
          startTime: { $lt: endTime },
          endTime: { $gt: startTime },
        })
          .session(session)
          .lean();

        if (existingReservation) {
          const err = new Error("This place is already booked for the selected date and time.");
          err.statusCode = 409;
          throw err;
        }
      } else {
        capacityServicePoints = await ServicePoint.find({
          businessId: business.businessId,
          isActive: { $ne: false },
          reservable: { $ne: false },
        })
          .select("servicePointId capacity")
          .session(session)
          .lean();

        const { capacity, valid } = validateReservationGuestCapacity({
          guestCount: guests,
          servicePoints: capacityServicePoints,
        });
        if (!valid) {
          const err = new Error(
            "Reservations cannot accommodate more than " + capacity + " guests.",
          );
          err.statusCode = 400;
          throw err;
        }
      }

      reservation = new Reservation({
        businessId: business.businessId,
        businessSlug: business.slug,
        customerName,
        phone,
        email,
        date,
        time: startTime,
        startTime,
        endTime,
        durationMinutes: duration,
        guestCount: guests,
        seatingPreference,
        servicePointId,
        servicePointLabel,
        specialRequest,
        status: "pending",
        source,
        ...overrides,
      });

      await reservation.save({ session });
    });
  } finally {
    await session.endSession();
  }

  try {
    const { publishEvent } = await import("../utils/sseManager.js");
    publishEvent("reservation_created", reservation.businessId, ["reservations", "owner"], {
      reservation: {
        id: String(reservation._id),
        status: reservation.status,
        customerName: reservation.customerName,
        guestCount: reservation.guestCount,
        date: reservation.date,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        servicePointLabel: reservation.servicePointLabel || null,
        type: "restaurant",
      },
    });
  } catch (err) {
    console.error("[createRestaurantReservation] SSE publish failed:", err);
  }

  const reservationObj = reservation.toObject();
  const businessDisplayName = business.displayName || business.name;
  const deliveryVersion = reservation.createdAt || new Date();
  const deliveries = [];

  const targetEmail = business.contactEmail || business.ownerEmail;
  if (targetEmail) {
    deliveries.push(
      dispatchRestaurantReservationEmail({
        jobName: EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER,
        businessId: reservation.businessId,
        reservationId: reservation._id,
        deliveryVersion,
        waitForDirect: false,
        directSend: () =>
          sendReservationRequestEmail({
            to: targetEmail,
            businessName: businessDisplayName,
            reservation: reservationObj,
          }),
      }),
    );
  }

  if (reservationObj.email) {
    deliveries.push(
      dispatchRestaurantReservationEmail({
        jobName: EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST,
        businessId: reservation.businessId,
        reservationId: reservation._id,
        deliveryVersion,
        waitForDirect: false,
        directSend: () =>
          sendReservationRequestReceivedEmail({
            to: reservationObj.email,
            businessName: businessDisplayName,
            businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
            primaryColor: business.branding?.primaryColor,
            reservation: reservationObj,
          }),
      }),
    );
  }
  await Promise.all(deliveries);

  return {
    message: "Reservation request received.",
    reservationId: reservation._id,
    reservation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED ENTRY POINT — routes public and staff calls appropriately
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified reservation creation service.
 * Used by both the public controller and the staff reservation controller.
 *
 * For hotel bookings, delegates to createHotelReservation().
 * For restaurant bookings, delegates to createRestaurantReservation().
 */
export async function createReservationService(data) {
  const {
    // Determine path
    isHotelBooking,
    businessSlug,
    // Common fields
    customerName,
    phone,
    email,
    guestCount,
    servicePointId,
    servicePointLabel,
    specialRequest,
    // Hotel-specific
    checkInDate,
    checkOutDate,
    // Restaurant-specific
    date,
    startTime,
    endTime,
    durationMinutes,
    seatingPreference,
    // System / derivation fields (staff-controlled)
    source = "public_hub",
    paymentMethod = null,
    checkInNow = false,
    staffSnapshot = null,
    // Legacy overrides path (restaurant / old callers) — kept for compat
    overrides = {},
    // Business is pre-loaded by the staff controller (avoid double lookup)
    business: preloadedBusiness = null,
  } = data;

  if (isHotelBooking) {
    // Staff callers pre-load the business; public callers provide businessSlug
    const business = preloadedBusiness
      ?? await Business.findOne({
        slug: String(businessSlug).toLowerCase(),
        status: { $in: ["active", "onboarding", "draft"] },
      }).lean();

    if (!business) {
      const err = new Error("Business not found or inactive");
      err.statusCode = 404;
      throw err;
    }

    return createHotelReservation({
      business,
      customerName,
      phone,
      email,
      checkInDate,
      checkOutDate,
      guestCount,
      servicePointId,
      specialRequest,
      source,
      paymentMethod,
      checkInNow,
      staffSnapshot,
    });
  }

  // ── Restaurant path ───────────────────────────────────────────────────────
  return createRestaurantReservation({
    businessSlug,
    customerName,
    phone,
    email,
    date,
    startTime,
    endTime,
    durationMinutes,
    guestCount,
    seatingPreference,
    servicePointId,
    servicePointLabel,
    specialRequest,
    source,
    overrides,
  });
}
