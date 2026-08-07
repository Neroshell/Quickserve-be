import Business from "../models/Business.js";
import Reservation from "../models/Reservation.js";
import { resolveBusinessCapabilities } from "./businessCapabilityService.js";
import { toPublicArrivalReservation } from "./reservationArrivalService.js";
import {
  createReservationNotComingToken,
  decodeReservationNotComingToken,
  hashReservationNotComingToken,
  isReservationNotComingTokenWellFormed,
  reservationNotComingTokenMatches,
} from "./reservationNotComingTokenService.js";

const INACTIVE_STATUSES = new Set([
  "completed",
  "expired",
  "no_show",
  "declined",
]);

async function publishRealtimeEvent(...args) {
  const { publishEvent } = await import("../utils/sseManager.js");
  return publishEvent(...args);
}

function isTimeslotBusiness(business) {
  return resolveBusinessCapabilities(business).reservations.primaryMode === "timeslot";
}

async function resolveQuery(query) {
  if (typeof query?.select === "function") {
    return query.select("+cancellationTokenHash");
  }
  return query;
}

function notComingOutcome(reservation, now) {
  if (reservation.status === "cancelled") {
    return "already_cancelled";
  }
  if (["arrived", "seated", "checked_in"].includes(reservation.status) || reservation.arrivalTokenUsedAt) {
    return "already_arrived";
  }
  if (INACTIVE_STATUSES.has(reservation.status)) return "inactive";
  const expiresAt = reservation.cancellationTokenExpiresAt || reservation.arrivalTokenExpiresAt;
  if (!expiresAt || expiresAt <= now) {
    return "expired";
  }
  if (reservation.status !== "confirmed") return "inactive";
  return "ready";
}

async function resolveNotComingContext({
  token,
  now,
  env,
  reservationModel,
  businessModel,
}) {
  if (!isReservationNotComingTokenWellFormed(token)) {
    return { outcome: "invalid" };
  }
  const tokenScope = decodeReservationNotComingToken(token, { env });
  if (!tokenScope) return { outcome: "invalid" };
  const tokenHash = hashReservationNotComingToken(token);
  const reservation = await resolveQuery(
    reservationModel.findOne({
      _id: tokenScope.reservationId,
      businessId: tokenScope.businessId,
      cancellationTokenHash: tokenHash,
    }),
  );
  if (!reservation || reservation.checkInDate) return { outcome: "invalid" };
  if (!reservationNotComingTokenMatches(token, reservation, { env })) {
    return { outcome: "invalid" };
  }
  const businessQuery = businessModel.findOne({ businessId: reservation.businessId });
  const business = typeof businessQuery?.lean === "function"
    ? await businessQuery.lean()
    : await businessQuery;
  if (!business || !isTimeslotBusiness(business)) return { outcome: "invalid" };
  return {
    outcome: notComingOutcome(reservation, now),
    tokenHash,
    reservation,
    business,
  };
}

export async function inspectReservationNotComingToken({
  token,
  now = new Date(),
  env = process.env,
  reservationModel = Reservation,
  businessModel = Business,
} = {}) {
  const context = await resolveNotComingContext({
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

export async function cancelRestaurantReservationNotComing({
  token,
  ip = null,
  userAgent = null,
  now = new Date(),
  env = process.env,
  reservationModel = Reservation,
  businessModel = Business,
  publish = publishRealtimeEvent,
} = {}) {
  const context = await resolveNotComingContext({
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
      cancellationTokenHash: context.tokenHash,
      cancellationTokenExpiresAt: { $gt: now },
      cancellationTokenUsedAt: null,
    },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: {
          actorType: "guest",
          name: context.reservation.customerName || "Guest",
          email: context.reservation.email || null,
          role: "guest",
        },
        cancellationReason: "guest_not_coming",
        cancellationSource: "arrival_reminder_email",
        cancellationTokenUsedAt: now,
      },
    },
    { new: true, runValidators: true },
  );

  if (!updated) {
    return inspectReservationNotComingToken({
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
    cancelledAt: updated.cancelledAt,
    cancelledBy: updated.cancelledBy,
    cancellationReason: updated.cancellationReason,
    cancellationSource: updated.cancellationSource,
    customerName: updated.customerName,
    guestCount: updated.guestCount,
    date: updated.date,
    startTime: updated.startTime,
    endTime: updated.endTime,
    servicePointLabel: updated.servicePointLabel || null,
  };

  try {
    await publish(
      "reservation_cancelled_by_guest",
      updated.businessId,
      ["reservations"],
      { reservation: staffReservation },
    );
  } catch (error) {
    console.error("[ReservationNotComing] SSE publish failed", {
      reservationId: String(updated._id),
      errorClass: error?.name || "Error",
    });
  }

  return { outcome: "cancelled", reservation: safeReservation };
}
