import { DateTime } from "luxon";
import Reservation from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import {
  buildReservationPricingSnapshot,
  getCustomerReservationPricing,
} from "./reservationPricingService.js";

export const BLOCKING_STAY_STATUSES = Object.freeze([
  "pending",
  "accepted_awaiting_payment",
  "confirmed",
  "checked_in",
]);

function hotelAvailabilityError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function buildHotelRoomEligibilityQuery({ businessId, servicePointId } = {}) {
  if (!businessId) throw hotelAvailabilityError("businessId is required");

  return {
    businessId,
    ...(servicePointId ? { servicePointId } : {}),
    isActive: { $ne: false },
    reservable: { $ne: false },
    $or: [
      { servicePointType: "room" },
      { servicePointType: { $exists: false } },
      { servicePointType: null },
    ],
  };
}

export function validateHotelStayWindow({
  business,
  checkInDate,
  checkOutDate,
  enforceFuture = true,
} = {}) {
  const checkIn = DateTime.fromISO(String(checkInDate || ""), { zone: "UTC" });
  const checkOut = DateTime.fromISO(String(checkOutDate || ""), { zone: "UTC" });
  if (
    !checkIn.isValid ||
    !checkOut.isValid ||
    checkIn.toISODate() !== checkInDate ||
    checkOut.toISODate() !== checkOutDate
  ) {
    throw hotelAvailabilityError(
      "checkInDate and checkOutDate must be valid ISO dates",
    );
  }

  const numberOfNights = checkOut.diff(checkIn, "days").days;
  if (!Number.isInteger(numberOfNights) || numberOfNights < 1) {
    throw hotelAvailabilityError("Check-out must be after check-in.");
  }

  const timezone = business?.timezone || "UTC";
  const businessToday = DateTime.now().setZone(timezone).toISODate();
  if (enforceFuture && checkInDate < businessToday) {
    throw hotelAvailabilityError("Check-in date cannot be in the past.");
  }

  return { businessToday, numberOfNights };
}

export function buildHotelStayOverlapQuery({
  businessId,
  servicePointId,
  servicePointIds,
  checkInDate,
  checkOutDate,
  excludeReservationId = null,
} = {}) {
  const query = {
    businessId,
    status: { $in: [...BLOCKING_STAY_STATUSES] },
    checkInDate: { $lt: checkOutDate },
    checkOutDate: { $gt: checkInDate },
  };

  if (servicePointId) query.servicePointId = servicePointId;
  else if (servicePointIds) query.servicePointId = { $in: servicePointIds };
  if (excludeReservationId) query._id = { $ne: excludeReservationId };

  return query;
}

export async function resolveHotelRoom({
  servicePointId,
  businessId,
  session,
  servicePointModel = ServicePoint,
} = {}) {
  const room = await servicePointModel.findOne(
    buildHotelRoomEligibilityQuery({ businessId, servicePointId }),
  )
    .session(session ?? null)
    .lean();

  if (!room) {
    throw hotelAvailabilityError(
      "The selected room is not available for booking.",
    );
  }

  return room;
}

/**
 * Acquires the canonical ServicePoint document as the transaction allocation
 * lock. Mutating hotel flows must take this lock before checking overlap so
 * concurrent transactions for the same physical room cannot both commit.
 */
export async function lockHotelRoomForReservation({
  servicePointId,
  businessId,
  session,
  servicePointModel = ServicePoint,
} = {}) {
  const room = await servicePointModel.findOneAndUpdate(
    buildHotelRoomEligibilityQuery({ businessId, servicePointId }),
    { $currentDate: { updatedAt: true } },
    { returnDocument: "after", session },
  ).lean();

  if (!room) {
    throw hotelAvailabilityError(
      "The selected room is not available for booking.",
    );
  }

  return room;
}

export async function assertNoRoomConflict({
  businessId,
  servicePointId,
  checkInDate,
  checkOutDate,
  excludeReservationId = null,
  session,
  reservationModel = Reservation,
} = {}) {
  const conflict = await reservationModel.findOne(buildHotelStayOverlapQuery({
    businessId,
    servicePointId,
    checkInDate,
    checkOutDate,
    excludeReservationId,
  }))
    .session(session ?? null)
    .lean();

  if (conflict) {
    throw hotelAvailabilityError(
      "This room is already booked for the selected dates.",
      409,
    );
  }
}

export async function calculateHotelStayPricing({
  business,
  pricePerNight,
  numberOfNights,
  commissionCalculator,
} = {}) {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight, numberOfNights },
    business,
    commissionCalculator,
  });
  return getCustomerReservationPricing(snapshot);
}

export function toHotelAvailabilityPricingSummary(pricing, numberOfNights) {
  return {
    nights: numberOfNights,
    subtotal: pricing.subtotal,
    taxAmount: pricing.taxAmount,
    taxAmountCents: pricing.taxAmountCents,
    taxRate: pricing.taxRate,
    customerPlatformFeeAmount: pricing.customerPlatformFeeAmount,
    customerPlatformFeeCents: pricing.customerPlatformFeeCents,
    total: pricing.total,
    totalCents: pricing.totalCents,
    hasAdditionalCharges:
      pricing.taxAmountCents > 0 || pricing.customerPlatformFeeCents > 0,
  };
}

function normalizeOptionalGuestCount(guestCount) {
  if (guestCount == null || guestCount === "") return null;
  const parsed = parseInt(guestCount, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 50) {
    throw hotelAvailabilityError("Guest count must be between 1 and 50.");
  }
  return parsed;
}

export async function findHotelRoomAvailability({
  business,
  checkInDate,
  checkOutDate,
  guestCount = null,
  servicePointId = null,
  servicePointModel = ServicePoint,
  reservationModel = Reservation,
  commissionCalculator,
} = {}) {
  if (!business?.businessId) {
    throw hotelAvailabilityError("Business not found", 404);
  }

  const { numberOfNights } = validateHotelStayWindow({
    business,
    checkInDate,
    checkOutDate,
  });
  const parsedGuestCount = normalizeOptionalGuestCount(guestCount);
  const rooms = await servicePointModel.find(buildHotelRoomEligibilityQuery({
    businessId: business.businessId,
    servicePointId,
  })).lean();

  if (!rooms.length) return { numberOfNights, rooms: [] };

  const conflicts = await reservationModel.find(buildHotelStayOverlapQuery({
    businessId: business.businessId,
    servicePointIds: rooms.map((room) => room.servicePointId),
    checkInDate,
    checkOutDate,
  }))
    .select("servicePointId")
    .lean();
  const blockedServicePointIds = new Set(
    conflicts.map((reservation) => reservation.servicePointId).filter(Boolean),
  );

  const availability = await Promise.all(rooms.map(async (room) => {
    const capacityExceeded = parsedGuestCount != null &&
      room.capacity != null &&
      parsedGuestCount > room.capacity;
    let pricingSummary = null;

    if (room.pricePerNight != null && Number(room.pricePerNight) > 0) {
      try {
        const pricing = await calculateHotelStayPricing({
          business,
          pricePerNight: room.pricePerNight,
          numberOfNights,
          commissionCalculator,
        });
        pricingSummary = toHotelAvailabilityPricingSummary(
          pricing,
          numberOfNights,
        );
      } catch (error) {
        console.error("[findHotelRoomAvailability] Pricing failed", {
          servicePointId: room.servicePointId,
          errorClass: error?.name || "Error",
        });
      }
    }

    return {
      ...room,
      available: !blockedServicePointIds.has(room.servicePointId),
      capacityExceeded,
      pricingSummary,
    };
  }));

  return { numberOfNights, rooms: availability };
}

export async function getHotelRoomPricingPreview({
  business,
  servicePointId,
  checkInDate,
  checkOutDate,
  servicePointModel = ServicePoint,
  commissionCalculator,
} = {}) {
  const { numberOfNights } = validateHotelStayWindow({
    business,
    checkInDate,
    checkOutDate,
  });
  const room = await resolveHotelRoom({
    businessId: business?.businessId,
    servicePointId,
    servicePointModel,
  });
  if (room.pricePerNight == null || Number(room.pricePerNight) <= 0) {
    throw hotelAvailabilityError("Invalid or unavailable room selected.");
  }

  return calculateHotelStayPricing({
    business,
    pricePerNight: room.pricePerNight,
    numberOfNights,
    commissionCalculator,
  });
}
