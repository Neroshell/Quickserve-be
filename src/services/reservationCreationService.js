import mongoose from "mongoose";
import crypto from "crypto";
import Reservation from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import { getCustomerReservationPricing, buildReservationPricingSnapshot } from "./reservationPricingService.js";
import {
  sendReservationConfirmedEmail,
  sendReservationRequestEmail,
  sendReservationRequestReceivedEmail,
} from "../utils/emailService.js";
import { dispatchRestaurantReservationEmail } from "./email/emailDispatchService.js";
import { EMAIL_JOB_NAMES, enqueueReservationPaymentExpiry } from "../queues/index.js";
import { getHotelPaymentExpiresAt } from "../constants/hotelConstants.js";
import {
  RESTAURANT_AVAILABILITY_POLICIES,
  allocateRestaurantServicePoint,
  assertRestaurantConfirmationConflict,
  assertRestaurantAvailabilityPolicy,
  hasRestaurantReservationCapacity,
  lockRestaurantServicePointForCreation,
  validateRestaurantPartySize,
  validateRestaurantReservationWindow,
} from "./restaurantReservationAvailabilityService.js";
import {
  PUBLIC_SERVABLE_BUSINESS_STATUSES,
  resolvePublicBusiness,
} from "./publicBusinessResolverService.js";
import {
  assertNoRoomConflict,
  lockHotelRoomForReservation,
  validateHotelStayWindow,
} from "./hotelReservationAvailabilityService.js";

export {
  BLOCKING_STAY_STATUSES,
  assertNoRoomConflict,
  lockHotelRoomForReservation,
  resolveHotelRoom,
} from "./hotelReservationAvailabilityService.js";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE C — Business-timezone date helper
// Returns the business-local calendar date as a "YYYY-MM-DD" string.
// Never use new Date().toISOString().split("T")[0] for hotel date checks.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY-BLOCKING STATUSES
// Any reservation in these statuses blocks the room for its date range.
// Must stay in sync with conflict checks everywhere.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeHotelAllocationTransactionError(error) {
  if (error?.statusCode) return error;

  const transient =
    error?.hasErrorLabel?.("TransientTransactionError") ||
    error?.hasErrorLabel?.("UnknownTransactionCommitResult") ||
    [112, 251].includes(error?.code) ||
    ["WriteConflict", "NoSuchTransaction"].includes(error?.codeName);

  if (!transient) return error;

  const conflict = new Error(
    "Room availability changed while the reservation was being saved. Please try again.",
  );
  conflict.statusCode = 409;
  conflict.code = "HOTEL_ROOM_ALLOCATION_CONFLICT";
  conflict.cause = error;
  return conflict;
}

function normalizeRestaurantAllocationTransactionError(error) {
  if (error?.statusCode) return error;

  const transient =
    error?.hasErrorLabel?.("TransientTransactionError") ||
    error?.hasErrorLabel?.("UnknownTransactionCommitResult") ||
    [112, 251].includes(error?.code) ||
    ["WriteConflict", "NoSuchTransaction"].includes(error?.codeName);
  if (!transient) return error;

  const conflict = new Error(
    "Restaurant availability changed while the reservation was being saved. Please try again.",
  );
  conflict.statusCode = 409;
  conflict.code = "RESTAURANT_SERVICE_POINT_ALLOCATION_CONFLICT";
  conflict.cause = error;
  return conflict;
}

export function normalizeCreationIdempotencyKey(value) {
  if (typeof value !== "string") {
    const error = new Error("A valid Idempotency-Key header is required.");
    error.statusCode = 400;
    throw error;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    const error = new Error(
      "Idempotency-Key must contain between 1 and 200 characters.",
    );
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

/**
 * Backward-compatible alias kept so that existing controller imports do not
 * need to change at the same time as this service.  Both names normalise
 * identically; the generic form is now canonical.
 * @deprecated Use normalizeCreationIdempotencyKey instead.
 */
export const normalizeRestaurantCreationIdempotencyKey = normalizeCreationIdempotencyKey;


function restaurantCreationFingerprint(values) {
  const canonical = {
    businessId: values.businessId,
    customerName: String(values.customerName || "").trim(),
    phone: String(values.phone || "").trim(),
    email: String(values.email || "").trim().toLowerCase(),
    date: values.date,
    startTime: values.startTime,
    endTime: values.endTime,
    durationMinutes: values.durationMinutes,
    guestCount: values.guestCount,
    seatingPreference: values.seatingPreference || "no_preference",
    requestedServicePointId: values.requestedServicePointId || null,
    specialRequest: String(values.specialRequest || "").trim(),
    source: values.source,
    initialStatus: values.initialStatus,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function hotelCreationFingerprint(values) {
  const canonical = {
    businessId: values.businessId,
    customerName: String(values.customerName || "").trim(),
    phone: String(values.phone || "").trim(),
    email: String(values.email || "").trim().toLowerCase(),
    checkInDate: values.checkInDate,
    checkOutDate: values.checkOutDate,
    guestCount: values.guestCount,
    servicePointId: values.servicePointId,
    specialRequest: String(values.specialRequest || "").trim(),
    source: values.source,
    paymentMethod: values.paymentMethod || null,
    checkInNow: Boolean(values.checkInNow),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function findCreationReplay({ businessId, idempotencyKey, session }) {
  if (!idempotencyKey) return null;
  const query = Reservation.findOne({
    businessId,
    $or: [
      { creationIdempotencyKey: idempotencyKey },
      { restaurantCreationIdempotencyKey: idempotencyKey }
    ]
  }).select("+creationIdempotencyKey +creationFingerprint +restaurantCreationIdempotencyKey +restaurantCreationFingerprint");
  return session ? query.session(session) : query;
}

function assertCreationReplayMatches(reservation, fingerprint) {
  if (reservation?.creationFingerprint === fingerprint || reservation?.restaurantCreationFingerprint === fingerprint) return;
  const error = new Error(
    "Idempotency-Key was already used for another reservation request.",
  );
  error.statusCode = 409;
  throw error;
}

/**
 * Atomically moves one hotel reservation to another physical room. The
 * destination ServicePoint lock and reservation update commit together.
 */
export async function reassignHotelReservationRoom({
  businessId,
  reservationId,
  newServicePointId,
  startSession = () => mongoose.startSession(),
}) {
  const session = await startSession();
  let reservation;
  let unchanged = false;

  try {
    await session.withTransaction(async () => {
      reservation = await Reservation.findOne({
        _id: reservationId,
        businessId,
      }).session(session);

      if (!reservation) {
        const err = new Error("Reservation not found.");
        err.statusCode = 404;
        throw err;
      }

      if (!reservation.checkInDate || !reservation.checkOutDate) {
        const err = new Error(
          "Room reassignment is only supported for hotel reservations.",
        );
        err.statusCode = 400;
        throw err;
      }

      if (["cancelled", "declined", "expired", "checked_out"].includes(reservation.status)) {
        const err = new Error("Cannot reassign a terminal reservation.");
        err.statusCode = 400;
        throw err;
      }

      if (reservation.servicePointId === newServicePointId) {
        unchanged = true;
        return;
      }

      let newRoom;
      try {
        newRoom = await lockHotelRoomForReservation({
          businessId,
          servicePointId: newServicePointId,
          session,
        });
      } catch (error) {
        if (error?.statusCode === 400) {
          error.statusCode = 404;
          error.message = "Target room not found or is not a reservable lodging room.";
        }
        throw error;
      }

      if (newRoom.capacity != null && reservation.guestCount > newRoom.capacity) {
        const err = new Error("Target room cannot accommodate the guest count.");
        err.statusCode = 400;
        throw err;
      }

      await assertNoRoomConflict({
        businessId,
        servicePointId: newServicePointId,
        checkInDate: reservation.checkInDate,
        checkOutDate: reservation.checkOutDate,
        excludeReservationId: reservation._id,
        session,
      });

      reservation.servicePointId = newRoom.servicePointId;
      reservation.servicePointLabel = newRoom.displayLabel || newRoom.label;
      reservation.roomTypeSnapshot = newRoom.roomType || null;
      await reservation.save({ session });
    });
  } catch (error) {
    throw normalizeHotelAllocationTransactionError(error);
  } finally {
    await session.endSession();
  }

  return { reservation, unchanged };
}

/**
 * Atomically moves an active restaurant reservation to another eligible
 * ServicePoint. This intentionally reuses the same allocator as creation.
 */
export async function reassignRestaurantReservationServicePoint({
  businessId,
  reservationId,
  newServicePointId,
  startSession = () => mongoose.startSession(),
}) {
  const session = await startSession();
  let reservation;
  let unchanged = false;

  try {
    await session.withTransaction(async () => {
      reservation = await Reservation.findOne({
        _id: reservationId,
        businessId,
      }).session(session);
      if (!reservation) {
        const error = new Error("Reservation not found.");
        error.statusCode = 404;
        throw error;
      }
      if (reservation.checkInDate || reservation.checkOutDate) {
        const error = new Error(
          "ServicePoint reassignment is only supported for restaurant reservations.",
        );
        error.statusCode = 400;
        throw error;
      }
      if (!["pending", "confirmed", "arrived", "seated"].includes(reservation.status)) {
        const error = new Error("Cannot reassign a terminal reservation.");
        error.statusCode = 400;
        throw error;
      }
      if (reservation.servicePointId === newServicePointId) {
        unchanged = true;
        return;
      }

      const allocatedServicePoint = await allocateRestaurantServicePoint({
        businessId,
        policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
        requestedServicePointId: newServicePointId,
        partySize: validateRestaurantPartySize(reservation.guestCount),
        date: reservation.date,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        excludeReservationId: reservation._id,
        session,
      });
      reservation.servicePointId = allocatedServicePoint.servicePointId;
      reservation.servicePointLabel = allocatedServicePoint.label;
      await reservation.save({ session });
    });
  } catch (error) {
    throw normalizeRestaurantAllocationTransactionError(error);
  } finally {
    await session.endSession();
  }

  return { reservation, unchanged };
}

/**
 * Confirms a restaurant reservation inside the same ServicePoint lock,
 * conflict recheck, and status-update transaction used by canonical
 * allocation. Controller availability reads remain advisory.
 */
export async function confirmRestaurantReservation({
  business,
  businessId = business?.businessId,
  reservationId,
  expectedStatus,
  actor = null,
  startSession = () => mongoose.startSession(),
}) {
  if (!businessId || !reservationId || !business) {
    const error = new Error("Business and reservation are required.");
    error.statusCode = 400;
    throw error;
  }

  const session = await startSession();
  let reservation;
  let replayed = false;
  let previousStatus = null;

  try {
    await session.withTransaction(async () => {
      reservation = await Reservation.findOne({
        _id: reservationId,
        businessId,
      }).session(session);
      if (!reservation) {
        const error = new Error("Reservation not found.");
        error.statusCode = 404;
        throw error;
      }
      if (reservation.checkInDate || reservation.checkOutDate) {
        const error = new Error(
          "Restaurant confirmation cannot be used for a stay reservation.",
        );
        error.statusCode = 400;
        throw error;
      }

      previousStatus = reservation.status;
      if (reservation.status === "confirmed") {
        replayed = true;
        return;
      }
      if (expectedStatus && reservation.status !== expectedStatus) {
        const error = new Error(
          "The reservation was updated elsewhere. Refresh and try again.",
        );
        error.statusCode = 409;
        throw error;
      }
      if (!reservation.servicePointId) {
        const error = new Error(
          "Assign an available ServicePoint before confirming this reservation.",
        );
        error.statusCode = 409;
        throw error;
      }

      validateRestaurantReservationWindow({
        business,
        date: reservation.date,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
      });

      const lockedServicePoint = await lockRestaurantServicePointForCreation({
        businessId,
        policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
        servicePointId: reservation.servicePointId,
        session,
      });
      if (
        !lockedServicePoint ||
        !hasRestaurantReservationCapacity(
          lockedServicePoint,
          validateRestaurantPartySize(reservation.guestCount),
        )
      ) {
        const error = new Error(
          "Restaurant availability changed while the reservation was being confirmed.",
        );
        error.statusCode = 409;
        throw error;
      }

      await assertRestaurantConfirmationConflict({
        businessId,
        servicePointId: lockedServicePoint.servicePointId,
        date: reservation.date,
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        reservationId: reservation._id,
        session,
      });

      reservation.status = "confirmed";
      if (!reservation.confirmedAt) reservation.confirmedAt = new Date();
      if (actor && !reservation.confirmedBy) reservation.confirmedBy = actor;
      reservation.servicePointLabel =
        lockedServicePoint.label || reservation.servicePointLabel;
      await reservation.save({ session });
    });
  } catch (error) {
    throw normalizeRestaurantAllocationTransactionError(error);
  } finally {
    await session.endSession();
  }

  return { reservation, previousStatus, replayed };
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
  source = 'public_hub',
  paymentMethod = null,
  checkInNow = false,
  staffSnapshot = null,
  idempotencyKey: rawIdempotencyKey = null,
  sideEffects = {},
}) {
  // Phase I: Validation
  if (!customerName || !phone || !email || !checkInDate || !checkOutDate || !guestCount || !servicePointId) {
    const err = new Error('Missing required fields.');
    err.statusCode = 400;
    throw err;
  }

  const { businessToday, numberOfNights } = validateHotelStayWindow({
    business,
    checkInDate,
    checkOutDate,
  });

  const guests = parseInt(guestCount, 10);
  if (isNaN(guests) || guests < 1 || guests > 50) {
    const err = new Error('Guest count must be between 1 and 50.');
    err.statusCode = 400;
    throw err;
  }

  if (specialRequest && specialRequest.length > 500) {
    const err = new Error('Special request is too long (max 500 characters).');
    err.statusCode = 400;
    throw err;
  }

  const isWalkIn = source === 'walk_in';
  if (isWalkIn) {
    const VALID_WALK_IN_PAYMENT = ['cash', 'pos_card'];
    if (!paymentMethod || !VALID_WALK_IN_PAYMENT.includes(paymentMethod)) {
      const err = new Error('Walk-in payment method must be "cash" or "pos_card".');
      err.statusCode = 400;
      throw err;
    }
  }

  // ARCH-006: Idempotency normalisation and pre-transaction replay lookup
  const idempotencyKey = rawIdempotencyKey == null
    ? null
    : normalizeCreationIdempotencyKey(rawIdempotencyKey);

  const fingerprint = hotelCreationFingerprint({
    businessId: business.businessId,
    customerName, phone, email,
    checkInDate, checkOutDate,
    guestCount: guests,
    servicePointId, specialRequest,
    source, paymentMethod, checkInNow,
  });

  let hotelReservation = await findCreationReplay({ businessId: business.businessId, idempotencyKey });
  let replayed = Boolean(hotelReservation);
  if (hotelReservation) assertCreationReplayMatches(hotelReservation, fingerprint);

  if (!hotelReservation) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // In-transaction serialization boundary replay check
        const transactionReplay = await findCreationReplay({ businessId: business.businessId, idempotencyKey, session });
        if (transactionReplay) {
          assertCreationReplayMatches(transactionReplay, fingerprint);
          hotelReservation = transactionReplay;
          replayed = true;
          return;
        }

        // Phase I rules 4-8: lock room, capacity, conflict
        const sp = await lockHotelRoomForReservation({ servicePointId, businessId: business.businessId, session });

        if (sp.capacity != null && guests > sp.capacity) {
          const err = new Error('This room accommodates a maximum of ' + sp.capacity + ' guests.');
          err.statusCode = 400;
          throw err;
        }

        await assertNoRoomConflict({ businessId: business.businessId, servicePointId, checkInDate, checkOutDate, session });

        const pricePerNight = sp.pricePerNight || 0;
        const now = new Date();

        let reservationStatus = 'pending';
        let paymentStatus = 'pending';
        let paymentChannel = null;
        let paidVia = null;
        let paidAt = null;
        let confirmedAt = null;
        let confirmedBy = null;
        let checkedInAt = null;
        let checkedInBy = null;
        let amountPaidCents = undefined;
        let secureToken = null;
        let paymentExpiresAt = null;
        const bookingMode = business.hotelSettings && business.hotelSettings.onlineBookingConfirmationMode || 'instant';

        if (isWalkIn) {
          reservationStatus = 'confirmed';
          paymentStatus = 'paid';
          paymentChannel = 'offline';
          paidVia = paymentMethod;
          paidAt = now;
          confirmedAt = now;
          confirmedBy = staffSnapshot;
          if (checkInNow && checkInDate === businessToday) {
            reservationStatus = 'checked_in';
            checkedInAt = now;
            checkedInBy = staffSnapshot;
          }
        } else if (bookingMode === 'instant') {
          reservationStatus = 'accepted_awaiting_payment';
          secureToken = crypto.randomBytes(32).toString('hex');
          paymentExpiresAt = getHotelPaymentExpiresAt(now);
        }

        const docFields = {
          businessId: business.businessId,
          businessSlug: business.slug,
          customerName, phone, email,
          checkInDate, checkOutDate,
          guestCount: guests,
          servicePointId: sp.servicePointId,
          servicePointLabel: sp.displayLabel || sp.label,
          roomTypeSnapshot: sp.roomType || null,
          specialRequest, pricePerNight, numberOfNights,
          currency: business.currency || 'eur',
          source,
          createdBy: staffSnapshot != null ? staffSnapshot : null,
          status: reservationStatus,
          paymentStatus, paymentChannel, paidVia, paidAt,
          confirmedAt, confirmedBy, checkedInAt, checkedInBy,
        };
        if (amountPaidCents != null) docFields.amountPaidCents = amountPaidCents;
        if (secureToken != null) docFields.secureToken = secureToken;
        if (paymentExpiresAt != null) docFields.paymentExpiresAt = paymentExpiresAt;
        // ARCH-006: hotel reservations use only generic idempotency fields
        if (idempotencyKey) {
          docFields.creationIdempotencyKey = idempotencyKey;
          docFields.creationFingerprint = fingerprint;
        }

        hotelReservation = new Reservation(docFields);

        try {
          const snapshot = await buildReservationPricingSnapshot({ reservation: hotelReservation, business });
          Object.assign(hotelReservation, snapshot);
          if (isWalkIn && hotelReservation.grossAmountCents) {
            hotelReservation.amountPaidCents = hotelReservation.grossAmountCents;
          }
        } catch (pricingErr) {
          console.error('[createHotelReservation] Pricing snapshot failed:', pricingErr);
        }

        await hotelReservation.save({ session });
      });
    } catch (error) {
      const duplicateCreationKey =
        error && error.code === 11000 &&
        (error.keyPattern && error.keyPattern.creationIdempotencyKey ||
          error.message && error.message.includes('uniq_reservation_creation_request'));
      if (!duplicateCreationKey || !idempotencyKey) {
        throw normalizeHotelAllocationTransactionError(error);
      }
      hotelReservation = await findCreationReplay({ businessId: business.businessId, idempotencyKey });
      if (!hotelReservation) throw normalizeHotelAllocationTransactionError(error);
      assertCreationReplayMatches(hotelReservation, fingerprint);
      replayed = true;
    } finally {
      await session.endSession();
    }
  }

  // Post-save side-effects: only on FIRST creation, never on replay
  if (!replayed && !isWalkIn && !(business.hotelSettings && business.hotelSettings.onlineBookingConfirmationMode === 'confirmation_required')) {
    const enqueuePaymentExpiry =
      sideEffects.enqueueReservationPaymentExpiry ||
      enqueueReservationPaymentExpiry;
    enqueuePaymentExpiry({
      businessId: business.businessId,
      reservationId: String(hotelReservation._id),
      expectedPaymentExpiry: hotelReservation.paymentExpiresAt,
    }).catch(function(err) { console.error('[createHotelReservation] Enqueue expiry failed:', err); });
  }

  if (!replayed) {
    try {
      const publishEvent = sideEffects.publishEvent ||
        (await import('../utils/sseManager.js')).publishEvent;
      const eventName = hotelReservation.status === 'checked_in' ? 'reservation_checked_in' : 'reservation_created';
      publishEvent(eventName, hotelReservation.businessId, ['reservations', 'owner'], {
        reservation: {
          id: String(hotelReservation._id),
          status: hotelReservation.status,
          customerName: hotelReservation.customerName,
          guestCount: hotelReservation.guestCount,
          checkInDate: hotelReservation.checkInDate,
          checkOutDate: hotelReservation.checkOutDate,
          servicePointLabel: hotelReservation.servicePointLabel || null,
          source: hotelReservation.source,
          type: 'hotel',
        },
      });
    } catch (err) {
      console.error('[createHotelReservation] SSE publish failed:', err);
    }
  }

  const reservationObj = hotelReservation.toObject();
  const businessDisplayName = business.displayName || business.name;
  const targetEmail = business.contactEmail || business.ownerEmail;
  const bookingMode2 = business.hotelSettings && business.hotelSettings.onlineBookingConfirmationMode || 'instant';
  const isInstant = !isWalkIn && bookingMode2 === 'instant';

  if (!replayed && !isWalkIn && !isInstant) {
    if (targetEmail) {
      const sendOwnerRequest =
        sideEffects.sendReservationRequestEmail ||
        sendReservationRequestEmail;
      sendOwnerRequest({ to: targetEmail, businessName: businessDisplayName, reservation: reservationObj })
        .catch(function(err) { console.error('[createHotelReservation] Owner email failed:', err); });
    }
    if (reservationObj.email) {
      const sendGuestRequest =
        sideEffects.sendReservationRequestReceivedEmail ||
        sendReservationRequestReceivedEmail;
      sendGuestRequest({
        to: reservationObj.email,
        businessName: businessDisplayName,
        businessLogoUrl: business.branding && business.branding.logoUrl || business.logoUrl,
        primaryColor: business.branding && business.branding.primaryColor,
        reservation: reservationObj,
      }).catch(function(err) { console.error('[createHotelReservation] Customer email failed:', err); });
    }
  }

  return {
    message: isWalkIn
      ? (hotelReservation.status === 'checked_in' ? 'Walk-in booked and guest checked in.' : 'Walk-in booking confirmed and paid.')
      : (isInstant ? 'Hotel booking created and awaiting payment.' : 'Hotel booking request received.'),
    reservationId: hotelReservation._id,
    pricing: getCustomerReservationPricing(hotelReservation),
    reservation: hotelReservation.toObject(),
    bookingMode: isWalkIn ? 'walk_in' : bookingMode2,
    replayed,
  };
}

// RESTAURANT / BAR BOOKING — unchanged from prior refactor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a restaurant timeslot reservation.
 * Called by both the public API and (rarely) the owner dashboard.
 */
export async function createRestaurantReservation({
  businessSlug,
  countryCode,
  business: preloadedBusiness = null,
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
  specialRequest,
  source = "public_hub",
  initialStatus = "pending",
  staffSnapshot = null,
  availabilityPolicy = RESTAURANT_AVAILABILITY_POLICIES.public,
  notificationMode = "request",
  idempotencyKey: rawIdempotencyKey = null,
  startSession = () => mongoose.startSession(),
  sideEffects = {},
}) {
  if (!businessSlug || !customerName || !phone || !email || !date || !startTime || !endTime || !guestCount) {
    const err = new Error("Missing required fields");
    err.statusCode = 400;
    throw err;
  }

  const guests = validateRestaurantPartySize(guestCount);

  if (specialRequest && specialRequest.length > 500) {
    const err = new Error("Special request is too long (max 500 characters)");
    err.statusCode = 400;
    throw err;
  }

  const business = preloadedBusiness || (await resolvePublicBusiness({
    businessSlug,
    countryCode,
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
  })).business;
  if (!business) {
    const err = new Error("Business not found or inactive");
    err.statusCode = 404;
    throw err;
  }

  assertRestaurantAvailabilityPolicy(business, availabilityPolicy);
  const { durationMinutes: duration } = validateRestaurantReservationWindow({
    business,
    date,
    startTime,
    endTime,
    durationMinutes,
    policy: availabilityPolicy,
  });

  const allowedInitialStatuses = new Set(["pending", "confirmed", "seated"]);
  if (!allowedInitialStatuses.has(initialStatus)) {
    const err = new Error("Invalid initial restaurant reservation status");
    err.statusCode = 400;
    throw err;
  }

  const idempotencyKey = rawIdempotencyKey == null
    ? null
    : normalizeCreationIdempotencyKey(rawIdempotencyKey);
  const fingerprint = restaurantCreationFingerprint({
    businessId: business.businessId,
    customerName,
    phone,
    email,
    date,
    startTime,
    endTime,
    durationMinutes: duration,
    guestCount: guests,
    seatingPreference: "no_preference",
    requestedServicePointId: servicePointId,
    specialRequest,
    source,
    initialStatus,
  });

  let reservation = await findCreationReplay({
    businessId: business.businessId,
    idempotencyKey,
  });
  let replayed = Boolean(reservation);
  if (reservation) assertCreationReplayMatches(reservation, fingerprint);

  if (!reservation) {
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        const transactionReplay = await findCreationReplay({
          businessId: business.businessId,
          idempotencyKey,
          session,
        });
        if (transactionReplay) {
          assertCreationReplayMatches(transactionReplay, fingerprint);
          reservation = transactionReplay;
          replayed = true;
          return;
        }

        const allocatedServicePoint = await allocateRestaurantServicePoint({
          businessId: business.businessId,
          policy: availabilityPolicy,
          requestedServicePointId: servicePointId,
          partySize: guests,
          date,
          startTime,
          endTime,
          session,
        });

        const now = new Date();
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
        // Chillow currently has no supported seating-area taxonomy. Absence of
        // a preference means automatic assignment, never an unassigned table.
        seatingPreference: "no_preference",
        servicePointId: allocatedServicePoint.servicePointId,
        servicePointLabel: allocatedServicePoint.label,
        ...(idempotencyKey
          ? {
            creationIdempotencyKey: idempotencyKey,
            creationFingerprint: fingerprint,
            restaurantCreationIdempotencyKey: idempotencyKey,
            restaurantCreationFingerprint: fingerprint,
          }
          : {}),
        specialRequest,
        status: initialStatus,
        source,
        ...(staffSnapshot ? { createdBy: staffSnapshot } : {}),
        ...(["confirmed", "seated"].includes(initialStatus)
          ? {
            confirmedAt: now,
            ...(staffSnapshot ? { confirmedBy: staffSnapshot } : {}),
          }
          : {}),
        ...(initialStatus === "seated"
          ? {
            arrivedAt: now,
            arrivalSource: "staff",
            seatedAt: now,
          }
          : {}),
      });

        await reservation.save({ session });
      });
    } catch (error) {
      const duplicateCreationKey =
        error?.code === 11000 &&
        (error?.keyPattern?.creationIdempotencyKey ||
          error?.keyPattern?.restaurantCreationIdempotencyKey ||
          error?.message?.includes("uniq_reservation_creation_request") ||
          error?.message?.includes("uniq_restaurant_reservation_creation_request"));
      if (!duplicateCreationKey || !idempotencyKey) {
        throw normalizeRestaurantAllocationTransactionError(error);
      }
      reservation = await findCreationReplay({
        businessId: business.businessId,
        idempotencyKey,
      });
      if (!reservation) throw normalizeRestaurantAllocationTransactionError(error);
      assertCreationReplayMatches(reservation, fingerprint);
      replayed = true;
    } finally {
      await session.endSession();
    }
  }

  if (!replayed) {
    try {
      const publishEvent = sideEffects.publishEvent ||
        (await import("../utils/sseManager.js")).publishEvent;
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
    const dispatchReservationEmail =
      sideEffects.dispatchRestaurantReservationEmail ||
      dispatchRestaurantReservationEmail;

    const targetEmail = business.contactEmail || business.ownerEmail;
    if (notificationMode === "request" && targetEmail) {
      deliveries.push(
        dispatchReservationEmail({
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

    if (notificationMode === "request" && reservationObj.email) {
      deliveries.push(
        dispatchReservationEmail({
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
    } else if (notificationMode === "confirmed" && reservationObj.email) {
      deliveries.push(
        dispatchReservationEmail({
          jobName: EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED,
          businessId: reservation.businessId,
          reservationId: reservation._id,
          deliveryVersion: reservation.confirmedAt || deliveryVersion,
          waitForDirect: false,
          directSend: () =>
            sendReservationConfirmedEmail({
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
  }

  return {
    message: initialStatus === "seated"
      ? "Walk-in guest seated."
      : initialStatus === "confirmed"
        ? "Reservation created and confirmed."
        : "Reservation request received.",
    reservationId: reservation._id,
    reservation,
    replayed,
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
    countryCode,
    // Common fields
    customerName,
    phone,
    email,
    guestCount,
    servicePointId,
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
    initialStatus = "pending",
    availabilityPolicy = RESTAURANT_AVAILABILITY_POLICIES.public,
    notificationMode = "request",
    idempotencyKey = null,
    sideEffects = {},
    // Business is pre-loaded by the staff controller (avoid double lookup)
    business: preloadedBusiness = null,
  } = data;

  const business = preloadedBusiness || (await resolvePublicBusiness({
    businessSlug,
    countryCode,
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
  })).business;
  if (!business) {
    const err = new Error("Business not found or inactive");
    err.statusCode = 404;
    throw err;
  }

  if (isHotelBooking) {
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
      idempotencyKey,
      sideEffects,
    });
  }

  // ── Restaurant path ───────────────────────────────────────────────────────
  return createRestaurantReservation({
    businessSlug: business.slug,
    countryCode: business.countryCode,
    business,
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
    specialRequest,
    source,
    initialStatus,
    staffSnapshot,
    availabilityPolicy,
    notificationMode,
    idempotencyKey,
    sideEffects,
  });
}
