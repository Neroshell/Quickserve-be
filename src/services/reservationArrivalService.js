import { DateTime } from "luxon";
import Business from "../models/Business.js";
import Reservation from "../models/Reservation.js";
import {
  EMAIL_JOB_NAMES,
  enqueueEmailJob,
} from "../queues/index.js";
import { isBullMqEmailsEnabled } from "./email/emailDispatchService.js";
import {
  ensureReservationEmailIntent,
  markReservationEmailEnqueued,
  markReservationEmailEnqueueFailed,
  normalizeDeliveryVersion,
} from "./email/reservationEmailDeliveryService.js";
import {
  createReservationArrivalToken,
  decodeReservationArrivalToken,
  hashReservationArrivalToken,
  isReservationArrivalTokenWellFormed,
  reservationArrivalTokenMatches,
} from "./reservationArrivalTokenService.js";
import {
  createReservationNotComingToken,
  hashReservationNotComingToken,
} from "./reservationNotComingTokenService.js";
import { resolveBusinessCapabilities } from "./businessCapabilityService.js";

export const DEFAULT_ARRIVAL_REMINDER_LEAD_MINUTES = 10;
export const MAX_ARRIVAL_REMINDER_LEAD_MINUTES = 7 * 24 * 60;
export const ARRIVAL_REMINDER_TEST_DELAY_ENV =
  "RESTAURANT_ARRIVAL_REMINDER_TEST_DELAY_SECONDS";

const INACTIVE_STATUSES = new Set([
  "cancelled",
  "completed",
  "expired",
  "no_show",
  "declined",
]);

async function publishRealtimeEvent(...args) {
  const { publishEvent } = await import("../utils/sseManager.js");
  return publishEvent(...args);
}

function plain(value) {
  return value?.toObject ? value.toObject() : { ...(value || {}) };
}

async function resolveQuery(query) {
  if (typeof query?.select === "function") {
    return query.select("+arrivalTokenHash +arrivalIp +arrivalUserAgent");
  }
  return query;
}

export function getArrivalReminderSettings(business) {
  const configuredLead = Number(business?.settings?.arrivalReminderLeadMinutes);
  const leadMinutes = Number.isInteger(configuredLead) &&
    configuredLead >= 0 &&
    configuredLead <= MAX_ARRIVAL_REMINDER_LEAD_MINUTES
    ? configuredLead
    : DEFAULT_ARRIVAL_REMINDER_LEAD_MINUTES;
  return {
    enabled: business?.settings?.arrivalReminderEnabled !== false,
    leadMinutes,
  };
}

export function getRestaurantReservationTiming(reservation, business) {
  const timezone = String(business?.timezone || "UTC");
  const date = String(reservation?.date || "");
  const startTime = String(reservation?.startTime || reservation?.time || "");
  const endTime = String(reservation?.endTime || "");
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
  const end = DateTime.fromISO(`${date}T${endTime}`, { zone: timezone });
  if (!start.isValid || !end.isValid || end <= start) {
    throw new TypeError("Reservation date/time is invalid");
  }
  return { start: start.toJSDate(), end: end.toJSDate(), timezone };
}

export function getLocalArrivalReminderTestDelaySeconds(env = process.env) {
  if (env?.NODE_ENV === "production") return null;
  const raw = String(env?.[ARRIVAL_REMINDER_TEST_DELAY_ENV] || "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function getArrivalReminderSchedule({
  reservation,
  business,
  now = new Date(),
  env = process.env,
}) {
  const timing = getRestaurantReservationTiming(reservation, business);
  const { leadMinutes } = getArrivalReminderSettings(business);
  const testDelaySeconds = isTimeslotBusiness(business)
    ? getLocalArrivalReminderTestDelaySeconds(env)
    : null;
  const localTestDelayActive = testDelaySeconds !== null;
  const desired = localTestDelayActive
    ? new Date(now.getTime() + testDelaySeconds * 1000)
    : new Date(timing.start.getTime() - leadMinutes * 60 * 1000);
  return {
    ...timing,
    scheduledFor: desired > now ? desired : new Date(now),
    delay: Math.max(0, desired.getTime() - now.getTime()),
    localTestDelayActive,
  };
}

function isTimeslotBusiness(business) {
  return resolveBusinessCapabilities(business).reservations.primaryMode === "timeslot";
}

export async function scheduleReservationArrivalReminder({
  reservation,
  business,
  now = new Date(),
  env = process.env,
  reservationModel = Reservation,
  ensureIntent = ensureReservationEmailIntent,
  enqueue = enqueueEmailJob,
  markEnqueued = markReservationEmailEnqueued,
  markFailed = markReservationEmailEnqueueFailed,
} = {}) {
  const record = plain(reservation);
  const settings = getArrivalReminderSettings(business);
  if (!isBullMqEmailsEnabled(env)) {
    return { queued: false, reason: "bullmq_email_disabled" };
  }
  if (!settings.enabled) {
    return { queued: false, reason: "business_reminder_disabled" };
  }
  if (!isTimeslotBusiness(business) || record.checkInDate) {
    return { queued: false, reason: "not_restaurant_reservation" };
  }
  if (record.status !== "confirmed") {
    return { queued: false, reason: "reservation_not_confirmed" };
  }
  if (!record.email) {
    return { queued: false, reason: "recipient_missing" };
  }

  const schedule = getArrivalReminderSchedule({
    reservation: record,
    business,
    now,
    env,
  });
  if (schedule.end <= now) {
    return { queued: false, reason: "reservation_ended" };
  }

  const deliveryVersion = normalizeDeliveryVersion(
    record.confirmedAt || record.updatedAt || now,
  );
  const tokenScope = {
    ...record,
    arrivalReminderVersion: deliveryVersion,
    arrivalTokenExpiresAt: schedule.end,
    cancellationTokenExpiresAt: schedule.end,
  };
  const token = createReservationArrivalToken(tokenScope, { env });
  const tokenHash = hashReservationArrivalToken(token);
  const cancellationToken = createReservationNotComingToken(tokenScope, { env });
  const cancellationTokenHash = hashReservationNotComingToken(cancellationToken);
  const reservationId = String(record._id);
  const claimed = await reservationModel.findOneAndUpdate(
    {
      _id: record._id,
      businessId: record.businessId,
      status: "confirmed",
      $or: [
        { arrivalReminderVersion: null },
        { arrivalReminderVersion: { $exists: false } },
      ],
    },
    {
      $set: {
        arrivalReminderVersion: deliveryVersion,
        arrivalReminderScheduledFor: schedule.scheduledFor,
        arrivalTokenHash: tokenHash,
        arrivalTokenIssuedAt: now,
        arrivalTokenExpiresAt: schedule.end,
        cancellationTokenHash,
        cancellationTokenIssuedAt: now,
        cancellationTokenExpiresAt: schedule.end,
      },
    },
    { new: true, runValidators: true },
  );

  let prepared = claimed;
  if (!prepared) {
    prepared = await resolveQuery(reservationModel.findOne({
      _id: record._id,
      businessId: record.businessId,
      status: "confirmed",
      arrivalReminderVersion: deliveryVersion,
    }));
  }
  if (!prepared) {
    return { queued: false, reason: "reservation_changed" };
  }

  let intent;
  try {
    intent = await ensureIntent({
      jobName: EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER,
      businessId: record.businessId,
      reservationId,
      deliveryVersion,
      scheduledFor: schedule.scheduledFor,
    });
    if (!intent || intent.status === "sent" || intent.status === "cancelled") {
      return { queued: false, reason: "delivery_not_eligible" };
    }

    const delay = Math.max(0, schedule.scheduledFor.getTime() - now.getTime());
    const queued = await enqueue(
      EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER,
      {
        businessId: record.businessId,
        reservationId,
        deliveryId: intent.deliveryId,
        deliveryVersion: intent.deliveryVersion,
      },
      { env, delay },
    );
    await markEnqueued({
      deliveryId: intent.deliveryId,
      businessId: record.businessId,
      now,
    });
    await reservationModel.updateOne(
      {
        _id: record._id,
        businessId: record.businessId,
        arrivalReminderVersion: deliveryVersion,
      },
      {
        $set: {
          arrivalReminderScheduledAt: now,
          arrivalReminderJobId: String(queued.jobId),
        },
      },
    );
    const jobId = String(queued.jobId);
    console.info("[ReservationArrival] Reminder scheduled", {
      reservationId,
      jobId,
      scheduledTime: schedule.scheduledFor.toISOString(),
      localTestDelayActive: schedule.localTestDelayActive,
    });
    return {
      queued: true,
      jobId,
      scheduledFor: schedule.scheduledFor,
      delay,
      localTestDelayActive: schedule.localTestDelayActive,
    };
  } catch (error) {
    if (intent?.deliveryId) {
      await markFailed({
        deliveryId: intent.deliveryId,
        businessId: record.businessId,
        error,
      }).catch(() => {});
    }
    return {
      queued: false,
      reason: "enqueue_failed",
      errorCode: error?.code || error?.name || "enqueue_failed",
    };
  }
}

export function toPublicArrivalReservation(reservation, business) {
  return {
    restaurantName: business?.displayName || business?.name || "Restaurant",
    date: reservation.date,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    guestName: reservation.customerName,
    guestCount: reservation.guestCount,
    servicePointLabel: reservation.servicePointLabel || null,
    notes: reservation.specialRequest || null,
    status: reservation.status,
    arrivedAt: reservation.arrivedAt || null,
  };
}

function arrivalOutcome(reservation, now) {
  if (["arrived", "seated"].includes(reservation.status) || reservation.arrivalTokenUsedAt) {
    return "already_checked_in";
  }
  if (INACTIVE_STATUSES.has(reservation.status)) return "inactive";
  if (!reservation.arrivalTokenExpiresAt || reservation.arrivalTokenExpiresAt <= now) {
    return "expired";
  }
  if (reservation.status !== "confirmed") return "not_ready";
  return "ready";
}

async function resolveArrivalContext({
  token,
  now,
  env,
  reservationModel,
  businessModel,
}) {
  if (!isReservationArrivalTokenWellFormed(token)) {
    return { outcome: "invalid" };
  }
  const tokenScope = decodeReservationArrivalToken(token, { env });
  if (!tokenScope) return { outcome: "invalid" };
  const tokenHash = hashReservationArrivalToken(token);
  const reservation = await resolveQuery(
    reservationModel.findOne({
      _id: tokenScope.reservationId,
      businessId: tokenScope.businessId,
      arrivalTokenHash: tokenHash,
    }),
  );
  if (!reservation || reservation.checkInDate) return { outcome: "invalid" };
  if (!reservationArrivalTokenMatches(token, reservation, { env })) {
    return { outcome: "invalid" };
  }
  const businessQuery = businessModel.findOne({ businessId: reservation.businessId });
  const business = typeof businessQuery?.lean === "function"
    ? await businessQuery.lean()
    : await businessQuery;
  if (!business || !isTimeslotBusiness(business)) return { outcome: "inactive" };
  return {
    outcome: arrivalOutcome(reservation, now),
    tokenHash,
    reservation,
    business,
  };
}

export async function inspectReservationArrivalToken({
  token,
  now = new Date(),
  env = process.env,
  reservationModel = Reservation,
  businessModel = Business,
} = {}) {
  const context = await resolveArrivalContext({
    token,
    now,
    env,
    reservationModel,
    businessModel,
  });
  return {
    outcome: context.outcome,
    reservation: context.reservation
      ? toPublicArrivalReservation(context.reservation, context.business)
      : null,
  };
}

export async function checkInRestaurantReservationArrival({
  token,
  ip = null,
  userAgent = null,
  now = new Date(),
  env = process.env,
  reservationModel = Reservation,
  businessModel = Business,
  publish = publishRealtimeEvent,
} = {}) {
  const context = await resolveArrivalContext({
    token,
    now,
    env,
    reservationModel,
    businessModel,
  });
  if (context.outcome !== "ready") {
    return {
      outcome: context.outcome,
      reservation: context.reservation
        ? toPublicArrivalReservation(context.reservation, context.business)
        : null,
    };
  }

  const updated = await reservationModel.findOneAndUpdate(
    {
      _id: context.reservation._id,
      businessId: context.reservation.businessId,
      status: "confirmed",
      arrivalTokenHash: context.tokenHash,
      arrivalTokenExpiresAt: { $gt: now },
      arrivalTokenUsedAt: null,
    },
    {
      $set: {
        status: "arrived",
        arrivedAt: now,
        arrivalTokenUsedAt: now,
        arrivalSource: "email",
        arrivalIp: ip ? String(ip).slice(0, 64) : null,
        arrivalUserAgent: userAgent ? String(userAgent).slice(0, 500) : null,
      },
    },
    { new: true, runValidators: true },
  );

  if (!updated) {
    return inspectReservationArrivalToken({
      token,
      now,
      env,
      reservationModel,
      businessModel,
    });
  }

  const safeReservation = toPublicArrivalReservation(updated, context.business);
  const staffReservation = {
    id: String(updated._id),
    status: updated.status,
    arrivedAt: updated.arrivedAt,
    customerName: updated.customerName,
    guestCount: updated.guestCount,
    date: updated.date,
    startTime: updated.startTime,
    endTime: updated.endTime,
    servicePointLabel: updated.servicePointLabel || null,
  };
  try {
    await publish(
      "reservation_arrived",
      updated.businessId,
      ["reservations"],
      { reservation: staffReservation },
    );
  } catch (error) {
    console.error("[ReservationArrival] SSE publish failed", {
      reservationId: String(updated._id),
      errorClass: error?.name || "Error",
    });
  }
  return { outcome: "checked_in", reservation: safeReservation };
}
