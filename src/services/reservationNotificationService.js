import {
  NOTIFICATION_TYPES,
} from "../constants/notifications.js";
import {
  buildNotificationIdempotencyKey,
  createNotificationEvent,
} from "./notificationService.js";

const RESERVATION_OCCURRENCES = Object.freeze({
  [NOTIFICATION_TYPES.RESERVATION_EXTERNAL_CREATED]: "external-created-v1",
  [NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED]: "guest-cancelled-v1",
  [NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED]: "guest-arrived-v1",
});

const MONTHS = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

function plain(value) {
  return value?.toObject
    ? value.toObject({ depopulate: true })
    : { ...(value || {}) };
}

function validDate(value, fallback) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function formatNotificationReservationTime(reservationValue) {
  const reservation = plain(reservationValue);
  const rawTime = String(reservation.startTime || reservation.time || "").trim();
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const meridiem = hour >= 12 ? "PM" : "AM";
      const displayHour = hour % 12 || 12;
      return `${displayHour}:${String(minute).padStart(2, "0")} ${meridiem}`;
    }
  }
  if (rawTime) return rawTime.slice(0, 80);

  const rawDate = String(reservation.checkInDate || reservation.date || "").trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
  if (dateMatch) {
    const month = MONTHS[Number(dateMatch[2]) - 1];
    if (month) return `Check-in ${Number(dateMatch[3])} ${month} ${dateMatch[1]}`;
  }
  return rawDate ? rawDate.slice(0, 80) : "scheduled time";
}

export function buildReservationNotificationFacts(reservationValue) {
  const reservation = plain(reservationValue);
  return {
    guestName: reservation.customerName || "A guest",
    partySize: reservation.guestCount,
    reservationTime: formatNotificationReservationTime(reservation),
    servicePointDisplayName:
      reservation.servicePointLabel || reservation.servicePointDisplayName || "",
  };
}

function occurredAtFor(type, reservation, now) {
  const candidate = type === NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED
    ? reservation.arrivalTokenUsedAt || reservation.arrivedAt
    : type === NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED
      ? reservation.cancellationTokenUsedAt || reservation.cancelledAt
      : reservation.createdAt;
  return validDate(candidate, now);
}

export async function createReservationNotification({
  type,
  reservation: reservationValue,
  now = new Date(),
}, {
  createEvent = createNotificationEvent,
} = {}) {
  const reservation = plain(reservationValue);
  const businessId = String(reservation.businessId || "").trim();
  const entityId = String(reservation._id || reservation.id || "").trim();
  const occurrenceId = RESERVATION_OCCURRENCES[type];
  if (!occurrenceId) {
    throw new TypeError(`Unsupported reservation notification type: ${String(type)}`);
  }

  return createEvent({
    businessId,
    type,
    entityId,
    occurredAt: occurredAtFor(type, reservation, now),
    idempotencyKey: buildNotificationIdempotencyKey({
      type,
      entityId,
      occurrenceId,
    }),
    facts: buildReservationNotificationFacts(reservation),
  });
}

export function notifyExternalReservationCreated(input, dependencies) {
  return createReservationNotification({
    ...input,
    type: NOTIFICATION_TYPES.RESERVATION_EXTERNAL_CREATED,
  }, dependencies);
}

export function notifyGuestReservationCancelled(input, dependencies) {
  return createReservationNotification({
    ...input,
    type: NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED,
  }, dependencies);
}

export function notifyGuestReservationArrived(input, dependencies) {
  return createReservationNotification({
    ...input,
    type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
  }, dependencies);
}
