import { DateTime } from "luxon";
import Business from "../models/Business.js";
import Reservation, {
  MIN_DURATION_MINUTES,
  timeStringToMinutes,
} from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import { getConfiguredServicePointCapacity } from "./reservationCapacityService.js";

export const RESTAURANT_BLOCKING_STATUSES = Object.freeze([
  "confirmed",
  "arrived",
  "seated",
]);

export const RESTAURANT_AVAILABILITY_POLICIES = Object.freeze({
  public: Object.freeze({
    name: "public",
    allowReservationsDisabled: false,
    allowNonReservableServicePoints: false,
    allowPastStart: false,
  }),
  owner: Object.freeze({
    name: "owner",
    allowReservationsDisabled: true,
    allowNonReservableServicePoints: false,
    allowPastStart: false,
  }),
  ownerWalkIn: Object.freeze({
    name: "owner_walk_in",
    allowReservationsDisabled: true,
    allowNonReservableServicePoints: true,
    // A newly seated walk-in may use the current five-minute bucket. This is
    // clock-drift tolerance, not permission to backdate a reservation.
    allowPastStart: true,
    pastStartGraceMinutes: 5,
  }),
});

const SLOT_INTERVAL_MINUTES = 30;
const RESTAURANT_SERVICE_POINT_TYPES = new Set(["table", "booth", "other"]);

function availabilityError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveNow(now, timezone) {
  if (DateTime.isDateTime(now)) return now.setZone(timezone);
  if (now instanceof Date) return DateTime.fromJSDate(now).setZone(timezone);
  if (typeof now === "string") {
    const parsed = DateTime.fromISO(now, { setZone: true });
    if (parsed.isValid) return parsed.setZone(timezone);
  }
  return DateTime.now().setZone(timezone);
}

function minutesToTime(total) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function getDayConfiguration(business, date) {
  const timezone = business.timezone || "UTC";
  const localDate = DateTime.fromISO(date, { zone: timezone });
  if (!localDate.isValid || localDate.toISODate() !== date) {
    throw availabilityError("date must be a valid YYYY-MM-DD value");
  }
  return business.operatingHours?.[localDate.toFormat("EEEE")] || null;
}

export function isRestaurantServicePoint(servicePoint) {
  const type = servicePoint?.servicePointType;
  // Missing types are retained only for legacy records. Room is always
  // rejected, including for businesses that also have lodging capability.
  return type == null || RESTAURANT_SERVICE_POINT_TYPES.has(type);
}

export function isRestaurantServicePointEligible(servicePoint, policy) {
  if (!servicePoint || servicePoint.isActive === false) return false;
  if (!isRestaurantServicePoint(servicePoint)) return false;
  if (!policy?.allowNonReservableServicePoints && servicePoint.reservable === false) {
    return false;
  }
  return true;
}

export function validateRestaurantPartySize(value) {
  const partySize = Number(value);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 50) {
    throw availabilityError("Party size must be between 1 and 50");
  }
  return partySize;
}

export function assertRestaurantAvailabilityPolicy(business, policy) {
  if (!business?.businessId) throw availabilityError("Business not found", 404);
  if (!policy?.name) throw availabilityError("Restaurant availability policy is required", 500);
  if (
    !policy.allowReservationsDisabled &&
    business.settings?.reservationsEnabled === false
  ) {
    throw availabilityError("Reservations are currently disabled for this business.", 403);
  }
}

export function validateRestaurantReservationWindow({
  business,
  date,
  startTime,
  endTime,
  durationMinutes,
  policy = RESTAURANT_AVAILABILITY_POLICIES.public,
  now,
}) {
  const startMinutes = timeStringToMinutes(startTime);
  const endMinutes = timeStringToMinutes(endTime);
  if (Number.isNaN(startMinutes) || Number.isNaN(endMinutes)) {
    throw availabilityError("startTime and endTime must be valid HH:MM values");
  }
  if (endMinutes <= startMinutes) {
    throw availabilityError("End time must be after start time");
  }

  const duration = endMinutes - startMinutes;
  if (durationMinutes != null && Number(durationMinutes) !== duration) {
    throw availabilityError("durationMinutes does not match the start/end time range");
  }
  if (duration < MIN_DURATION_MINUTES) {
    throw availabilityError(`Duration must be at least ${MIN_DURATION_MINUTES} minutes`);
  }

  assertRestaurantAvailabilityPolicy(business, policy);
  const timezone = business.timezone || "UTC";
  const dayConfig = getDayConfiguration(business, date);
  if (!dayConfig?.enabled) {
    throw availabilityError("Reservations are only available during business hours.");
  }
  if (startTime < dayConfig.openTime || endTime > dayConfig.closeTime) {
    throw availabilityError("Reservations are only available during business hours.");
  }

  const reservationStart = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
  if (!reservationStart.isValid) {
    throw availabilityError("Invalid date or time format");
  }
  const earliestStart = resolveNow(now, timezone).minus({
    minutes: policy.allowPastStart ? policy.pastStartGraceMinutes || 0 : 0,
  });
  if (reservationStart < earliestStart) {
    throw availabilityError("Reservation cannot be in the past");
  }

  return {
    startMinutes,
    endMinutes,
    durationMinutes: duration,
    reservationStart,
    timezone,
    dayConfig,
  };
}

export function buildRestaurantServicePointQuery({
  businessId,
  policy,
  servicePointId,
}) {
  return {
    businessId,
    isActive: { $ne: false },
    ...(policy.allowNonReservableServicePoints
      ? {}
      : { reservable: { $ne: false } }),
    ...(servicePointId ? { servicePointId } : {}),
    $or: [
      { servicePointType: { $in: [...RESTAURANT_SERVICE_POINT_TYPES] } },
      { servicePointType: { $exists: false } },
      { servicePointType: null },
    ],
  };
}

export function buildRestaurantConflictQuery({
  businessId,
  servicePointId,
  date,
  startTime,
  endTime,
  excludeReservationId,
}) {
  return {
    businessId,
    servicePointId,
    date,
    status: { $in: [...RESTAURANT_BLOCKING_STATUSES] },
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
    ...(excludeReservationId ? { _id: { $ne: excludeReservationId } } : {}),
  };
}

function applySession(query, session) {
  return session && typeof query.session === "function" ? query.session(session) : query;
}

export async function findEligibleRestaurantServicePoints({
  businessId,
  policy,
  servicePointId,
  session,
}) {
  let query = ServicePoint.find(
    buildRestaurantServicePointQuery({ businessId, policy, servicePointId }),
  ).select("businessId servicePointId label servicePointType capacity reservable isActive");
  query = applySession(query, session);
  const servicePoints = await query.lean();
  // The database query is the primary tenant boundary. The second check keeps
  // this service fail-closed if a mock, plugin, or future query helper is wrong.
  return servicePoints.filter((point) =>
    String(point.businessId) === String(businessId) &&
    isRestaurantServicePointEligible(point, policy)
  );
}

/**
 * Acquires the ServicePoint document as the transaction's allocation lock.
 * Concurrent transactions selecting the same physical resource cannot both
 * commit: MongoDB retries the loser, whose subsequent overlap check then sees
 * the winning reservation. Availability remains advisory; this is the final
 * write-path serialization point.
 */
export async function lockRestaurantServicePointForCreation({
  businessId,
  policy,
  servicePointId,
  session,
}) {
  let query = ServicePoint.findOneAndUpdate(
    buildRestaurantServicePointQuery({ businessId, policy, servicePointId }),
    { $currentDate: { updatedAt: true } },
    { new: true, session },
  ).select("businessId servicePointId label servicePointType capacity reservable isActive");
  query = applySession(query, session);
  const servicePoint = await query.lean();
  if (
    !servicePoint ||
    String(servicePoint.businessId) !== String(businessId) ||
    !isRestaurantServicePointEligible(servicePoint, policy)
  ) return null;
  return servicePoint;
}

export async function assertNoRestaurantReservationConflict({
  businessId,
  servicePointId,
  date,
  startTime,
  endTime,
  excludeReservationId,
  session,
}) {
  let query = Reservation.findOne(buildRestaurantConflictQuery({
    businessId,
    servicePointId,
    date,
    startTime,
    endTime,
    excludeReservationId,
  }));
  query = applySession(query, session);
  const conflict = await query.lean();
  if (conflict) {
    throw availabilityError(
      "This service point is already booked for the selected date and time.",
      409,
    );
  }
}

function hasCapacity(servicePoint, partySize) {
  const capacity = getConfiguredServicePointCapacity(servicePoint);
  return capacity === null || partySize <= capacity;
}

function overlaps(reservation, startTime, endTime) {
  return reservation.startTime < endTime && reservation.endTime > startTime;
}

function availablePointsForRange({
  servicePoints,
  reservations,
  date,
  startTime,
  endTime,
}) {
  return servicePoints.filter((servicePoint) => !reservations.some((reservation) =>
    reservation.date === date &&
    reservation.servicePointId === servicePoint.servicePointId &&
    overlaps(reservation, startTime, endTime)
  ));
}

export async function findAvailableRestaurantServicePointsForRange({
  businessId,
  servicePoints,
  partySize,
  date,
  startTime,
  endTime,
  session,
}) {
  const candidates = servicePoints.filter((point) => hasCapacity(point, partySize));
  if (candidates.length === 0) return [];

  let query = Reservation.find({
    businessId,
    servicePointId: { $in: candidates.map((point) => point.servicePointId) },
    date,
    status: { $in: [...RESTAURANT_BLOCKING_STATUSES] },
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  }).select("businessId servicePointId date startTime endTime status");
  query = applySession(query, session);
  const reservations = (await query.lean()).filter((reservation) =>
    String(reservation.businessId) === String(businessId) &&
    RESTAURANT_BLOCKING_STATUSES.includes(reservation.status)
  );
  return availablePointsForRange({
    servicePoints: candidates,
    reservations,
    date,
    startTime,
    endTime,
  });
}

function generateRangeEndTimes(startMinutes, closeMinutes) {
  const values = [];
  for (
    let end = startMinutes + MIN_DURATION_MINUTES;
    end <= closeMinutes;
    end += SLOT_INTERVAL_MINUTES
  ) {
    values.push(minutesToTime(end));
  }
  const closeTime = minutesToTime(closeMinutes);
  if (
    closeMinutes - startMinutes >= MIN_DURATION_MINUTES &&
    values.at(-1) !== closeTime
  ) {
    values.push(closeTime);
  }
  return values;
}

function evaluateRestaurantDate({
  business,
  date,
  durationMinutes,
  servicePoints,
  reservations,
  selectedServicePointId,
  policy,
  now,
}) {
  const timezone = business.timezone || "UTC";
  const localDate = DateTime.fromISO(date, { zone: timezone });
  const localNow = resolveNow(now, timezone);
  if (!localDate.isValid || localDate.toISODate() !== date) {
    return { reason: "invalid_date", availableStartTimes: [], dayConfig: null };
  }
  if (date < localNow.toISODate()) {
    return { reason: "past_date", availableStartTimes: [], dayConfig: null };
  }

  const dayConfig = getDayConfiguration(business, date);
  if (!dayConfig?.enabled) {
    return { reason: "closed", availableStartTimes: [], dayConfig };
  }
  const openMinutes = timeStringToMinutes(dayConfig.openTime);
  const closeMinutes = timeStringToMinutes(dayConfig.closeTime);
  if (
    Number.isNaN(openMinutes) ||
    Number.isNaN(closeMinutes) ||
    closeMinutes <= openMinutes
  ) {
    return { reason: "closed", availableStartTimes: [], dayConfig };
  }

  const selectedPoint = selectedServicePointId
    ? servicePoints.find((point) => point.servicePointId === selectedServicePointId)
    : null;
  const candidatePoints = selectedServicePointId
    ? selectedPoint ? [selectedPoint] : []
    : servicePoints;
  const candidateStarts = [];
  for (let start = openMinutes; start + durationMinutes <= closeMinutes; start += SLOT_INTERVAL_MINUTES) {
    candidateStarts.push(start);
  }
  if (policy?.name === "owner_walk_in" && date === localNow.toISODate()) {
    const currentBucket = Math.floor((localNow.hour * 60 + localNow.minute) / 5) * 5;
    if (
      currentBucket >= openMinutes &&
      currentBucket + durationMinutes <= closeMinutes &&
      !candidateStarts.includes(currentBucket)
    ) {
      candidateStarts.push(currentBucket);
      candidateStarts.sort((left, right) => left - right);
    }
  }

  const earliestStart = localNow.minus({
    minutes: policy?.allowPastStart ? policy.pastStartGraceMinutes || 0 : 0,
  });
  const availableStartTimes = [];
  for (const start of candidateStarts) {
    const startTime = minutesToTime(start);
    const endTime = minutesToTime(start + durationMinutes);
    const startsAt = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
    if (startsAt < earliestStart) continue;
    if (availablePointsForRange({
      servicePoints: candidatePoints,
      reservations,
      date,
      startTime,
      endTime,
    }).length > 0) {
      availableStartTimes.push(startTime);
    }
  }

  return {
    reason: availableStartTimes.length > 0 ? null : "no_available_times",
    availableStartTimes,
    dayConfig,
  };
}

function servicePointDto(servicePoint) {
  return {
    servicePointId: servicePoint.servicePointId,
    label: servicePoint.label,
    servicePointType: servicePoint.servicePointType || "table",
    capacity: getConfiguredServicePointCapacity(servicePoint),
  };
}

function enumerateMonthDates(month, timezone) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) {
    throw availabilityError("month must be a valid YYYY-MM value");
  }
  const first = DateTime.fromISO(`${month}-01`, { zone: timezone });
  if (!first.isValid || first.toFormat("yyyy-MM") !== month) {
    throw availabilityError("month must be a valid YYYY-MM value");
  }
  return Array.from({ length: first.daysInMonth }, (_, index) =>
    first.plus({ days: index }).toISODate()
  );
}

export async function getRestaurantAvailability({
  businessId,
  business: preloadedBusiness,
  date,
  month,
  partySize: rawPartySize,
  durationMinutes: rawDurationMinutes = 90,
  startTime,
  servicePointId,
  policy,
  now,
}) {
  const business = preloadedBusiness || await Business.findOne({ businessId }).lean();
  if (!business || business.businessId !== businessId) {
    throw availabilityError("Business not found", 404);
  }
  assertRestaurantAvailabilityPolicy(business, policy);

  const partySize = validateRestaurantPartySize(rawPartySize);
  const durationMinutes = Number(rawDurationMinutes);
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < MIN_DURATION_MINUTES ||
    durationMinutes >= 24 * 60
  ) {
    throw availabilityError(`Duration must be between ${MIN_DURATION_MINUTES} and 1439 minutes`);
  }

  const timezone = business.timezone || "UTC";
  const localNow = resolveNow(now, timezone);
  const effectiveMonth = month || date?.slice(0, 7);
  const monthDates = effectiveMonth ? enumerateMonthDates(effectiveMonth, timezone) : [];
  if (!date && monthDates.length === 0) {
    throw availabilityError("date or month is required");
  }
  if (date) getDayConfiguration(business, date);

  const servicePoints = await findEligibleRestaurantServicePoints({
    businessId,
    policy,
  });
  const capacityCompatiblePoints = servicePoints.filter((point) =>
    hasCapacity(point, partySize)
  );

  const queryDates = [...new Set([
    ...monthDates,
    ...(date ? [date] : []),
  ])].sort();
  const reservationQuery = {
    businessId,
    date: queryDates.length === 1 ? queryDates[0] : { $in: queryDates },
    status: { $in: [...RESTAURANT_BLOCKING_STATUSES] },
    servicePointId: { $in: servicePoints.map((point) => point.servicePointId) },
  };
  const reservations = servicePoints.length > 0
    ? await Reservation.find(reservationQuery)
      .select("businessId servicePointId date startTime endTime status")
      .lean()
    : [];
  const tenantReservations = reservations.filter((reservation) =>
    String(reservation.businessId) === String(businessId) &&
    RESTAURANT_BLOCKING_STATUSES.includes(reservation.status)
  );

  const selectedServicePointEligible = !servicePointId || capacityCompatiblePoints.some(
    (point) => point.servicePointId === servicePointId,
  );
  const availableDates = monthDates.filter((candidateDate) =>
    evaluateRestaurantDate({
      business,
      date: candidateDate,
      durationMinutes,
      servicePoints: capacityCompatiblePoints,
      reservations: tenantReservations,
      selectedServicePointId: servicePointId,
      policy,
      now: localNow,
    }).availableStartTimes.length > 0
  );

  let dateAvailability = {
    reason: capacityCompatiblePoints.length > 0 ? null : "no_service_point_can_fit_party",
    availableStartTimes: [],
    dayConfig: null,
  };
  let validEndTimes = [];
  let availableServicePoints = capacityCompatiblePoints;
  let selectedServicePointAvailable = !servicePointId;
  let noPreferenceAvailable = availableDates.length > 0;

  if (date) {
    const noPreferenceDateAvailability = capacityCompatiblePoints.length === 0
      ? { availableStartTimes: [] }
      : evaluateRestaurantDate({
        business,
        date,
        durationMinutes,
        servicePoints: capacityCompatiblePoints,
        reservations: tenantReservations,
        policy,
        now: localNow,
      });
    dateAvailability = capacityCompatiblePoints.length === 0
      ? { reason: "no_service_point_can_fit_party", availableStartTimes: [], dayConfig: getDayConfiguration(business, date) }
      : evaluateRestaurantDate({
        business,
        date,
        durationMinutes,
        servicePoints: capacityCompatiblePoints,
        reservations: tenantReservations,
        selectedServicePointId: servicePointId,
        policy,
        now: localNow,
      });

    if (startTime && !Number.isNaN(timeStringToMinutes(startTime)) && dateAvailability.dayConfig?.enabled) {
      const startMinutes = timeStringToMinutes(startTime);
      const openMinutes = timeStringToMinutes(dateAvailability.dayConfig.openTime);
      const closeMinutes = timeStringToMinutes(dateAvailability.dayConfig.closeTime);
      const startsAt = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
      const candidatePoints = servicePointId
        ? capacityCompatiblePoints.filter((point) => point.servicePointId === servicePointId)
        : capacityCompatiblePoints;
      const earliestStart = localNow.minus({
        minutes: policy.allowPastStart ? policy.pastStartGraceMinutes || 0 : 0,
      });
      const startIsValid =
        startMinutes >= openMinutes &&
        startMinutes < closeMinutes &&
        startsAt.isValid &&
        startsAt >= earliestStart;
      validEndTimes = startIsValid
        ? generateRangeEndTimes(startMinutes, closeMinutes).filter((endTime) =>
          availablePointsForRange({
            servicePoints: candidatePoints,
            reservations: tenantReservations,
            date,
            startTime,
            endTime,
          }).length > 0
        )
        : [];

      const requestedEndTime = minutesToTime(startMinutes + durationMinutes);
      availableServicePoints = startIsValid && startMinutes + durationMinutes <= closeMinutes
        ? availablePointsForRange({
          servicePoints: capacityCompatiblePoints,
          reservations: tenantReservations,
          date,
          startTime,
          endTime: requestedEndTime,
        })
        : [];
      selectedServicePointAvailable = !servicePointId || availableServicePoints.some(
        (point) => point.servicePointId === servicePointId,
      );
      noPreferenceAvailable = availableServicePoints.length > 0;
    } else {
      availableServicePoints = capacityCompatiblePoints.filter((point) =>
        evaluateRestaurantDate({
          business,
          date,
          durationMinutes,
          servicePoints: [point],
          reservations: tenantReservations,
          selectedServicePointId: point.servicePointId,
          policy,
          now: localNow,
        }).availableStartTimes.length > 0
      );
      selectedServicePointAvailable = !servicePointId || (
        selectedServicePointEligible && availableServicePoints.some(
          (point) => point.servicePointId === servicePointId,
        )
      );
      noPreferenceAvailable = noPreferenceDateAvailability.availableStartTimes.length > 0;
    }
  }

  return {
    date: date || null,
    month: effectiveMonth || null,
    businessTimezone: timezone,
    businessLocalDate: localNow.toISODate(),
    businessLocalTime: localNow.toFormat("HH:mm"),
    durationMinutes,
    reason: dateAvailability.reason,
    availableDates,
    availableStartTimes: dateAvailability.availableStartTimes,
    validEndTimes,
    servicePoints: availableServicePoints.map(servicePointDto),
    noPreferenceAvailable,
    selectedServicePointAvailable,
  };
}
