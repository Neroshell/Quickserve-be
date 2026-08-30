import mongoose from "mongoose";
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
import { createReservationService, createHotelReservation } from "../services/reservationCreationService.js";
import { HOTEL_PAYMENT_WINDOW_MINUTES, getHotelPaymentExpiresAt } from "../constants/hotelConstants.js";
import { resolveBusinessDay } from "../utils/businessDate.js";

const MAX_CHECK_IN_CODE_ATTEMPTS = 5;
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
  pending: ["confirmed", "declined", "cancelled"],
  confirmed: ["arrived", "no_show", "cancelled"],
  arrived: ["cancelled"],
  // seated and completed are terminal legacy states; no new transitions lead into them.
  seated: [],
  completed: [],
  cancelled: [],
  declined: [],
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
    const {
      businessId: requestedBusinessId,
      view,
      cursor,
      previousCursor,
      limit: reqLimit,
      status,
      date,
      month,
      start,
      endExclusive,
      search,
      clientToday,
      sortBy,
      sortDirection,
    } = req.query;

    const sessionUser = req.session?.user;
    const businessId = sessionUser?.role === "admin"
      ? requestedBusinessId || sessionUser.businessId
      : sessionUser?.businessId;

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" });
    }
    if (
      sessionUser?.role !== "admin" &&
      requestedBusinessId &&
      requestedBusinessId !== businessId
    ) {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    const limit = parseInt(reqLimit, 10) || 25;

    // Route authorization has already admitted the caller. Resolve the business
    // strictly inside the authenticated tenant for owners, co-owners, and Managers.
    const business = await Business.findOne({ businessId }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const caps = resolveBusinessCapabilities(business)?.reservations;
    const isHotel = caps && caps.primaryMode === "stay";

    // Keep the owner view synchronized with the same persisted expiry state as
    // the scheduled job, without client-side polling or duplicate UI state.
    await expireAwaitingPaymentReservations({ businessId });

    const baseQuery = { businessId, archivedAt: null };

    // =========================================================================
    // 0. TODAY PMS WORKSPACE VIEW
    // =========================================================================

    if (view === "today" && isHotel) {
      const { businessDay } = resolveBusinessDay(business);
      
      const todayQuery = {
        ...baseQuery,
        $or: [
          { checkInDate: businessDay },
          { checkOutDate: businessDay },
          { status: "checked_in" }
        ]
      };
      
      const rawReservations = await Reservation.find(todayQuery).lean();
      const allRes = rawReservations.map(toOwnerReservationResponse);

      const arrivals = allRes.filter(r => 
        r.checkInDate === businessDay && 
        ["pending", "accepted_awaiting_payment", "confirmed", "checked_in", "checked_out"].includes(r.status)
      );

      const departures = allRes.filter(r => 
        r.checkOutDate === businessDay && 
        ["checked_in", "checked_out"].includes(r.status)
      );

      const inHouse = allRes.filter(r => r.status === "checked_in");

      const arrivalsCheckedIn = arrivals.filter(r => ["checked_in", "checked_out"].includes(r.status)).length;
      const departuresCheckedOut = departures.filter(r => r.status === "checked_out").length;
      const inHouseGuests = inHouse.reduce((sum, r) => sum + (r.guestCount || 0), 0);

      const { BLOCKING_STAY_STATUSES } = await import("../services/reservationCreationService.js");
      
      const totalRooms = await mongoose.model("ServicePoint").countDocuments({
        businessId,
        isActive: { $ne: false },
        reservable: { $ne: false },
        $or: [
          { servicePointType: "room" },
          { servicePointType: { $exists: false } },
          { servicePointType: null },
        ]
      });

      const tomorrowDate = new Date(businessDay);
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowStr = tomorrowDate.toISOString().split("T")[0];

      const occupiedRooms = await Reservation.distinct("servicePointId", {
        businessId,
        status: { $in: [...BLOCKING_STAY_STATUSES] },
        checkInDate: { $lt: tomorrowStr },
        checkOutDate: { $gt: businessDay }
      });

      const available = Math.max(0, totalRooms - occupiedRooms.length);

      return res.json({
        businessDate: businessDay,
        operations: {
          arrivals,
          departures,
          inHouse
        },
        stats: {
          arrivalsToday: {
            total: arrivals.length,
            checkedIn: arrivalsCheckedIn,
            remaining: arrivals.length - arrivalsCheckedIn
          },
          departuresToday: {
            total: departures.length,
            checkedOut: departuresCheckedOut,
            remaining: departures.length - departuresCheckedOut
          },
          inHouse: {
            reservations: inHouse.length,
            guests: inHouseGuests
          },
          availableTonight: {
            available,
            totalRooms
          }
        }
      });
    }

    // =========================================================================
    // 1. NON-PAGINATED VIEWS: CALENDAR AND DAY
    // =========================================================================

    if (view === "calendar") {
      if (isHotel && start && endExclusive) {
        // Tape-chart range query: [start, endExclusive)
        // Includes any reservation that overlaps the visible window:
        //   checkInDate  < endExclusive  (starts before window closes)
        //   checkOutDate > start         (ends after window opens)
        baseQuery.checkInDate  = { $lt: endExclusive };
        baseQuery.checkOutDate = { $gt: start };
        const reservations = await Reservation.find(baseQuery).lean();
        return res.json(reservations.map(toOwnerReservationResponse));
      }

      if (!month) return res.status(400).json({ error: "month (YYYY-MM) or start/endExclusive is required for calendar view" });
      const monthStart = `${month}-01`;
      const nextMonthDate = new Date(`${month}-01T00:00:00Z`);
      nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
      const monthEnd = nextMonthDate.toISOString().split("T")[0];

      if (isHotel) {
        baseQuery.checkInDate  = { $lt: monthEnd };
        baseQuery.checkOutDate = { $gt: monthStart };
      } else {
        baseQuery.date = { $regex: `^${month}` };
      }
      const reservations = await Reservation.find(baseQuery).lean();
      return res.json(reservations.map(toOwnerReservationResponse));
    }

    if (view === "day") {
      if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) is required for day view" });

      if (isHotel) {
        baseQuery.checkInDate = { $lte: date };
        baseQuery.checkOutDate = { $gt: date };
      } else {
        baseQuery.date = date;
      }
      const reservations = await Reservation.find(baseQuery).lean();
      return res.json(reservations.map(toOwnerReservationResponse));
    }

    // =========================================================================
    // 2. PAGINATED VIEW: LIST (OR LEGACY FALLBACK)
    // =========================================================================

    const activeQuery = { ...baseQuery };
    if (status && status !== "all") activeQuery.status = status;
    if (date) {
      if (isHotel) {
        activeQuery.checkInDate = date;
      } else {
        activeQuery.date = date;
      }
    }

    if (search) {
      const queryRegex = new RegExp(search, "i");
      activeQuery.$or = [
        { customerName: queryRegex },
        { email: queryRegex },
        { phone: queryRegex }
      ];
    }

    if (view === "list") {
      // A. Calculate Global Stats and Total Count
      const todayStr = clientToday || new Date().toISOString().split("T")[0];
      const tomorrowDate = new Date(todayStr);
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowStr = tomorrowDate.toISOString().split("T")[0];

      const [statsResult, totalCount] = await Promise.all([
        Reservation.aggregate([
          { $match: baseQuery }, // Global to the business, unaffected by activeQuery filters
          {
            $group: {
              _id: null,
              today: {
                $sum: { $cond: [{ $eq: [{ $ifNull: ["$checkInDate", "$date"] }, todayStr] }, 1, 0] }
              },
              upcoming: {
                $sum: { $cond: [{ $gt: [{ $ifNull: ["$checkInDate", "$date"] }, todayStr] }, 1, 0] }
              },
              pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
              confirmed: { $sum: { $cond: [{ $eq: ["$status", "confirmed"] }, 1, 0] } },
              arrived: { $sum: { $cond: [{ $eq: ["$status", "arrived"] }, 1, 0] } },
              // Hotel-specific metrics
              arrivalsToday: {
                $sum: {
                  $cond: [
                    { $and: [
                        { $eq: ["$checkInDate", todayStr] },
                        { $in: ["$status", ["pending", "accepted_awaiting_payment", "confirmed", "checked_in", "checked_out"]] }
                    ] },
                    1, 0
                  ]
                }
              },
              departuresToday: {
                $sum: {
                  $cond: [
                    { $and: [
                        { $eq: ["$checkOutDate", todayStr] },
                        { $in: ["$status", ["checked_in", "checked_out"]] }
                    ] },
                    1, 0
                  ]
                }
              },
              inHouse: {
                $sum: { $cond: [{ $eq: ["$status", "checked_in"] }, 1, 0] }
              }
            }
          }
        ]),
        Reservation.countDocuments(activeQuery)
      ]);

      const stats = statsResult[0] || { today: 0, upcoming: 0, pending: 0, confirmed: 0, arrived: 0, arrivalsToday: 0, departuresToday: 0, inHouse: 0 };
      delete stats._id;

      if (isHotel) {
        const { BLOCKING_STAY_STATUSES } = await import("../services/reservationCreationService.js");
        const totalRooms = await mongoose.model("ServicePoint").countDocuments({
          businessId,
          isActive: { $ne: false },
          reservable: { $ne: false },
          $or: [
            { servicePointType: "room" },
            { servicePointType: { $exists: false } },
            { servicePointType: null },
          ]
        });
        const occupiedRooms = await Reservation.distinct("servicePointId", {
          businessId,
          status: { $in: [...BLOCKING_STAY_STATUSES] },
          checkInDate: { $lt: tomorrowStr },
          checkOutDate: { $gt: todayStr }
        });
        stats.availableRooms = Math.max(0, totalRooms - occupiedRooms.length);
      }

      // B. Build Cursor Traversal
      const activeSortBy = sortBy === "checkInDate" ? "checkInDate" : "createdAt";
      const activeSortDir = sortDirection === "asc" ? 1 : -1;

      let sortObj, reverseSortObj;
      if (activeSortBy === "createdAt") {
        sortObj = { createdAt: activeSortDir, _id: activeSortDir };
        reverseSortObj = { createdAt: -activeSortDir, _id: -activeSortDir };
      } else {
        sortObj = { sortDate: activeSortDir, sortTime: activeSortDir, _id: activeSortDir };
        reverseSortObj = { sortDate: -activeSortDir, sortTime: -activeSortDir, _id: -activeSortDir };
      }

      let cursorMatch = null;
      let isReversing = false;

      const buildCursorMatch = (c, isReverse) => {
        const dir = isReverse ? -activeSortDir : activeSortDir;
        const op = dir === 1 ? "$gt" : "$lt";

        if (activeSortBy === "createdAt") {
          return {
            $or: [
              { createdAt: { [op]: new Date(c.createdAt) } },
              { createdAt: new Date(c.createdAt), _id: { [op]: new mongoose.Types.ObjectId(c._id) } }
            ]
          };
        } else {
          return {
            $or: [
              { sortDate: { [op]: c.sortDate } },
              { sortDate: c.sortDate, sortTime: { [op]: c.sortTime } },
              { sortDate: c.sortDate, sortTime: c.sortTime, _id: { [op]: new mongoose.Types.ObjectId(c._id) } }
            ]
          };
        }
      };

      if (previousCursor) {
        isReversing = true;
        const c = JSON.parse(Buffer.from(previousCursor, "base64url").toString("utf-8"));
        cursorMatch = buildCursorMatch(c, true);
      } else if (cursor) {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
        cursorMatch = buildCursorMatch(c, false);
      }

      const pipeline = [
        { $match: activeQuery },
        {
          $addFields: {
            sortDate: { $ifNull: ["$checkInDate", "$date", ""] },
            sortTime: { $ifNull: ["$time", ""] }
          }
        }
      ];

      if (cursorMatch) pipeline.push({ $match: cursorMatch });
      pipeline.push({ $sort: isReversing ? reverseSortObj : sortObj });
      pipeline.push({ $limit: limit + 1 });

      let rawReservations = await Reservation.aggregate(pipeline);

      let hasNextPage = false;
      let hasPreviousPage = false;

      if (isReversing) {
        hasPreviousPage = rawReservations.length > limit;
        if (hasPreviousPage) rawReservations.pop();
        rawReservations.reverse();
        hasNextPage = true;
      } else {
        hasNextPage = rawReservations.length > limit;
        if (hasNextPage) rawReservations.pop();
        hasPreviousPage = Boolean(cursor);
      }

      const encodeCursor = (doc) => {
        if (!doc) return null;
        let payload;
        if (activeSortBy === "createdAt") {
          payload = { createdAt: doc.createdAt, _id: doc._id.toString() };
        } else {
          payload = { sortDate: doc.sortDate, sortTime: doc.sortTime, _id: doc._id.toString() };
        }
        return Buffer.from(JSON.stringify(payload)).toString("base64url");
      };

      const nextCursorVal = hasNextPage && rawReservations.length > 0
        ? encodeCursor(rawReservations[rawReservations.length - 1])
        : null;

      const previousCursorVal = hasPreviousPage && rawReservations.length > 0
        ? encodeCursor(rawReservations[0])
        : null;

      return res.json({
        reservations: rawReservations.map(toOwnerReservationResponse),
        pagination: {
          hasNextPage,
          hasPreviousPage,
          nextCursor: nextCursorVal,
          previousCursor: previousCursorVal,
          totalCount
        },
        stats
      });
    }

    // Legacy unpaginated fallback (if UI hasn't been updated yet or view is omitted)
    const reservations = await Reservation.find(activeQuery).sort({ date: 1, time: 1 }).lean();
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
    const validStatuses = ["pending", "confirmed", "arrived", "cancelled", "declined", "no_show",
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
            status: { $in: ["confirmed", "arrived"] },
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
      if (status === "arrived" && !isHotel && !reservation.arrivedAt) {
        fields.arrivedAt = now;
        fields.arrivalSource = "staff";
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

      // Emit real-time event for every status transition so the dashboard
      // updates without a manual refresh.
      {
        const eventName = `reservation_${status}`;
        const emit = req.app?.locals?.publishEvent || publishReservationEvent;
        emit(eventName, reservation.businessId, ["reservations", "owner"], {
          reservation: {
            id: String(reservation._id),
            status: reservation.status,
            previousStatus,
            customerName: reservation.customerName,
            guestCount: reservation.guestCount,
            date: isHotel ? null : reservation.date,
            checkInDate: isHotel ? reservation.checkInDate : null,
            checkOutDate: isHotel ? reservation.checkOutDate : null,
            startTime: isHotel ? null : reservation.startTime,
            endTime: isHotel ? null : reservation.endTime,
            servicePointLabel: reservation.servicePointLabel || null,
            type: isHotel ? "hotel" : "restaurant",
          },
        }).catch(err => console.error("[Reservation] SSE publish failed", {
          reservationId: String(reservation._id),
          event: eventName,
          errorClass: err?.name || "Error",
        }));
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

    // Compute canonical pricing summary per room so room cards can display
    // the actual guest-payable total (including tax and platform fees) without
    // any client-side calculation.
    const msPerDay = 1000 * 60 * 60 * 24;
    const numberOfNights = Math.max(
      1,
      Math.round((new Date(checkOutDate) - new Date(checkInDate)) / msPerDay),
    );

    const { calculateOnlinePricing, getCustomerPricingBreakdown } = await import("../services/pricingService.js");

    const roomsWithPricing = await Promise.all(
      availableServicePoints.map(async (sp) => {
        if (sp.pricePerNight == null || Number(sp.pricePerNight) <= 0) {
          return { ...sp, pricingSummary: null };
        }
        try {
          const subtotalCents = Math.round(Number(sp.pricePerNight) * numberOfNights * 100);
          const pricing = await calculateOnlinePricing({ subtotalCents, business });
          const breakdown = getCustomerPricingBreakdown(pricing);
          return {
            ...sp,
            pricingSummary: {
              nights: numberOfNights,
              subtotal: breakdown.subtotal,
              taxAmount: breakdown.taxAmount,
              taxAmountCents: breakdown.taxAmountCents,
              taxRate: breakdown.taxRate,
              customerPlatformFeeAmount: breakdown.customerPlatformFeeAmount,
              customerPlatformFeeCents: breakdown.customerPlatformFeeCents,
              total: breakdown.total,
              totalCents: breakdown.totalCents,
              hasAdditionalCharges: breakdown.taxAmountCents > 0 || breakdown.customerPlatformFeeCents > 0,
            },
          };
        } catch (err) {
          console.error(`[getAvailableStayServicePoints] pricing failed for ${sp.servicePointId}:`, err);
          return { ...sp, pricingSummary: null };
        }
      }),
    );

    res.json(roomsWithPricing);
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

/**
 * POST /owner/reservations
 * Staff-created hotel walk-in booking from the dashboard.
 *
 * Product rules (enforced server-side):
 * - source is always walk_in — never trusted from client
 * - paymentChannel is always offline
 * - paidVia must be "cash" or "pos_card"
 * - paymentStatus is always "paid" — no unpaid walk-in
 * - status is "confirmed" unless checkInNow=true AND checkInDate is business-local today
 * - createdBy is always derived from the authenticated session
 * - businessId is always from the authenticated session
 */
export async function createStaffReservation(req, res) {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser || !sessionUser.businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const businessId = sessionUser.businessId;
    const business = await Business.findOne({ businessId }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    // Capabilities check: business must have lodging capability
    const { resolveBusinessCapabilities } = await import("../services/businessCapabilityService.js");
    const capabilities = await resolveBusinessCapabilities(business);
    if (!capabilities?.visibleModules?.includes("lodging")) {
      return res.status(403).json({ error: "This business does not have lodging capability." });
    }

    // Extract ONLY safe, allowlisted fields from the request body.
    // We deliberately ignore any attempt by the client to send:
    //   status, paymentStatus, paidVia, paymentChannel, createdBy, bookingSource, source
    const {
      customerName,
      phone,
      email,
      checkInDate,
      checkOutDate,
      guestCount,
      servicePointId,
      specialRequest,
      paymentMethod, // "cash" | "pos_card"
      checkInNow,    // boolean — only honoured when check-in date = business-local today
    } = req.body;

    // Phase E: Build staff attribution server-side
    const staffSnapshot = buildReservationStaffSnapshot(sessionUser);

    const result = await createHotelReservation({
      business,
      customerName,
      phone,
      email,
      checkInDate,
      checkOutDate,
      guestCount,
      servicePointId,
      specialRequest,
      source: "walk_in",       // Phase D: always walk_in for staff bookings
      paymentMethod,            // validated inside createHotelReservation
      checkInNow: Boolean(checkInNow),
      staffSnapshot,            // Phase E: createdBy / checkedInBy attribution
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[reservationController.createStaffReservation] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /owner/reservations/availability
 * Returns all room-type service points for the business, annotated with
 * availability for the requested checkInDate/checkOutDate range.
 *
 * Used by the staff New Booking form to show available rooms (Phase N).
 */
export async function getHotelRoomAvailability(req, res) {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser || !sessionUser.businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { checkInDate, checkOutDate, guestCount } = req.query;

    if (!checkInDate || !checkOutDate) {
      return res.status(400).json({ error: "checkInDate and checkOutDate are required" });
    }
    if (checkOutDate <= checkInDate) {
      return res.status(400).json({ error: "checkOutDate must be after checkInDate" });
    }

    const businessId = sessionUser.businessId;

    // Fetch all reservable service points that are room-type (or untyped — backward compat)
    const servicePoints = await ServicePoint.find({
      businessId,
      isActive: { $ne: false },
      reservable: { $ne: false },
      $or: [
        { servicePointType: "room" },
        { servicePointType: { $exists: false } },
        { servicePointType: null },
      ],
    })
      .select("servicePointId label displayLabel servicePointType roomType capacity pricePerNight")
      .lean();

    if (!servicePoints.length) {
      return res.status(200).json({ rooms: [] });
    }

    // Find all blocking reservations that overlap the requested range
    const { BLOCKING_STAY_STATUSES } = await import("../services/reservationCreationService.js");
    const blockedServicePointIds = new Set();
    const conflicts = await Reservation.find({
      businessId,
      servicePointId: { $in: servicePoints.map((sp) => sp.servicePointId) },
      status: { $in: [...BLOCKING_STAY_STATUSES] },
      checkInDate: { $lt: checkOutDate },
      checkOutDate: { $gt: checkInDate },
    })
      .select("servicePointId")
      .lean();

    for (const c of conflicts) {
      blockedServicePointIds.add(c.servicePointId);
    }

    const guestCountNum = guestCount ? parseInt(guestCount, 10) : null;

    // Compute canonical pricing summary per room so staff room cards can display
    // the actual guest-payable total (including tax and platform fees) without
    // any client-side calculation. Uses the same engine as reservation creation.
    const msPerDay = 1000 * 60 * 60 * 24;
    const numberOfNights = Math.max(
      1,
      Math.round((new Date(checkOutDate) - new Date(checkInDate)) / msPerDay),
    );

    const business = await Business.findOne({ businessId }).lean();
    const { calculateOnlinePricing, getCustomerPricingBreakdown } = await import("../services/pricingService.js");

    const rooms = await Promise.all(
      servicePoints.map(async (sp) => {
        const baseRoom = {
          servicePointId: sp.servicePointId,
          label: sp.displayLabel || sp.label,
          servicePointType: sp.servicePointType || "room",
          roomType: sp.roomType || null,
          capacity: sp.capacity ?? null,
          pricePerNight: sp.pricePerNight ?? null,
          available: !blockedServicePointIds.has(sp.servicePointId),
          capacityExceeded:
            guestCountNum != null && sp.capacity != null && guestCountNum > sp.capacity,
          pricingSummary: null,
        };

        if (!sp.pricePerNight || Number(sp.pricePerNight) <= 0 || !business) {
          return baseRoom;
        }

        try {
          const subtotalCents = Math.round(Number(sp.pricePerNight) * numberOfNights * 100);
          const pricing = await calculateOnlinePricing({ subtotalCents, business });
          const breakdown = getCustomerPricingBreakdown(pricing);
          return {
            ...baseRoom,
            pricingSummary: {
              nights: numberOfNights,
              subtotal: breakdown.subtotal,
              taxAmount: breakdown.taxAmount,
              taxAmountCents: breakdown.taxAmountCents,
              taxRate: breakdown.taxRate,
              customerPlatformFeeAmount: breakdown.customerPlatformFeeAmount,
              customerPlatformFeeCents: breakdown.customerPlatformFeeCents,
              total: breakdown.total,
              totalCents: breakdown.totalCents,
              hasAdditionalCharges: breakdown.taxAmountCents > 0 || breakdown.customerPlatformFeeCents > 0,
            },
          };
        } catch (err) {
          console.error(`[getHotelRoomAvailability] pricing failed for ${sp.servicePointId}:`, err);
          return baseRoom;
        }
      }),
    );

    return res.status(200).json({ rooms });
  } catch (error) {
    console.error("[reservationController.getHotelRoomAvailability] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /owner/reservations/pricing-preview
 * Returns the canonical pricing breakdown for a stay, matching what would be calculated during reservation creation.
 */
export async function getHotelPricingPreview(req, res) {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser || !sessionUser.businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { checkInDate, checkOutDate, servicePointId } = req.query;

    if (!checkInDate || !checkOutDate || !servicePointId) {
      return res.status(400).json({ error: "checkInDate, checkOutDate, and servicePointId are required" });
    }
    if (checkOutDate <= checkInDate) {
      return res.status(400).json({ error: "checkOutDate must be after checkInDate" });
    }

    const businessId = sessionUser.businessId;
    const business = await Business.findOne({ businessId }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const servicePoint = await ServicePoint.findOne({
      businessId,
      servicePointId,
      isActive: { $ne: false },
      reservable: { $ne: false }
    }).lean();

    if (!servicePoint || !servicePoint.pricePerNight) {
      return res.status(400).json({ error: "Invalid or unavailable room selected." });
    }

    const msPerDay = 1000 * 60 * 60 * 24;
    const numberOfNights = Math.round(
      (new Date(checkOutDate) - new Date(checkInDate)) / msPerDay,
    );

    const subtotalCents = Math.round(servicePoint.pricePerNight * numberOfNights * 100);

    const { calculateOnlinePricing, getCustomerPricingBreakdown } = await import("../services/pricingService.js");

    const pricing = await calculateOnlinePricing({
      subtotalCents,
      business,
    });

    const customerPricing = getCustomerPricingBreakdown(pricing);

    return res.status(200).json(customerPricing);
  } catch (error) {
    console.error("[reservationController.getHotelPricingPreview] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * PATCH /owner/reservations/:id/room
 * Safely reassigns a hotel reservation to a different room.
 */
export async function reassignHotelRoom(req, res) {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser || !sessionUser.businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const businessId = sessionUser.businessId;
    const { id } = req.params;
    const { servicePointId: newServicePointId } = req.body;

    if (!newServicePointId) {
      return res.status(400).json({ error: "New room ID is required." });
    }

    const scope = reservationScope(req, id);
    if (!scope) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const reservation = await Reservation.findOne(scope);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }

    if (!reservation.checkInDate || !reservation.checkOutDate) {
      return res.status(400).json({ error: "Room reassignment is only supported for hotel reservations." });
    }

    if (reservation.status === "cancelled" || reservation.status === "declined" || reservation.status === "expired" || reservation.status === "checked_out") {
      return res.status(400).json({ error: "Cannot reassign a terminal reservation." });
    }

    if (reservation.servicePointId === newServicePointId) {
      return res.status(200).json({ message: "Room is already assigned.", reservation: toOwnerReservationResponse(reservation) });
    }

    const newRoom = await mongoose.model("ServicePoint").findOne({
      businessId,
      servicePointId: newServicePointId,
      isActive: { $ne: false },
      reservable: { $ne: false },
      $or: [
        { servicePointType: "room" },
        { servicePointType: { $exists: false } },
        { servicePointType: null },
      ]
    }).lean();

    if (!newRoom) {
      return res.status(404).json({ error: "Target room not found or is not a reservable lodging room." });
    }

    if (newRoom.capacity != null && reservation.guestCount > newRoom.capacity) {
      return res.status(400).json({ error: "Target room cannot accommodate the guest count." });
    }

    const { BLOCKING_STAY_STATUSES } = await import("../services/reservationCreationService.js");

    const conflict = await Reservation.findOne({
      _id: { $ne: reservation._id },
      businessId,
      servicePointId: newServicePointId,
      status: { $in: [...BLOCKING_STAY_STATUSES] },
      checkInDate: { $lt: reservation.checkOutDate },
      checkOutDate: { $gt: reservation.checkInDate }
    }).lean();

    if (conflict) {
      return res.status(409).json({ error: "Target room is not available for the entire stay." });
    }

    reservation.servicePointId = newRoom.servicePointId;
    reservation.servicePointLabel = newRoom.displayLabel || newRoom.label;
    reservation.roomTypeSnapshot = newRoom.roomType || null;

    await reservation.save();

    await publishReservationEvent(businessId, {
      type: "reservation_updated",
      reservation: toOwnerReservationResponse(reservation),
    });

    return res.status(200).json({
      message: "Room reassigned successfully.",
      reservation: toOwnerReservationResponse(reservation)
    });

  } catch (error) {
    console.error("[reservationController.reassignHotelRoom] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}
