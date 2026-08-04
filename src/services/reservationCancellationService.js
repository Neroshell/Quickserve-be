import crypto from "crypto";
import Business from "../models/Business.js";
import Reservation from "../models/Reservation.js";
import ReservationRefund from "../models/ReservationRefund.js";
import { sendReservationRefundEmail } from "../utils/emailService.js";
import { canRefundReservation } from "./reservationRefundAuthorization.js";
import { dispatchRefundConfirmation } from "./email/emailDispatchService.js";
import { deliverRefundEmailDirect } from "./email/refundEmailDeliveryService.js";

export const RESERVATION_CANCELLATION_OUTCOMES = Object.freeze([
  "cancel_unpaid",
  "no_refund",
  "full_refund",
  "partial_refund",
]);

export const RESERVATION_CANCELLATION_REASONS = Object.freeze([
  "guest_request",
  "duplicate_booking",
  "payment_issue",
  "hotel_unavailable",
  "other",
]);

const CANCELLABLE_UNPAID_STATUSES = new Set([
  "pending",
  "pending_approval",
  "accepted_awaiting_payment",
  "confirmed",
]);
const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "partially_refunded",
  "refunded",
]);
const REFUNDABLE_PAYMENT_STATUSES = new Set([
  "paid",
  "partially_refunded",
]);

export class ReservationCancellationError extends Error {
  constructor(message, { status = 400, code = "INVALID_REQUEST", details } = {}) {
    super(message);
    this.name = "ReservationCancellationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function integerCents(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

export function getReservationCapturedAmountCents(reservation) {
  const amountPaidCents = integerCents(reservation?.amountPaidCents);
  if (amountPaidCents && amountPaidCents > 0) return amountPaidCents;

  const grossAmount = integerCents(reservation?.grossAmount);
  if (grossAmount && grossAmount > 0) return grossAmount;

  const totalPriceCents = Math.round(Number(reservation?.totalPrice || 0) * 100);
  return Number.isSafeInteger(totalPriceCents) && totalPriceCents > 0
    ? totalPriceCents
    : 0;
}

export function getRemainingRefundableAmountCents({
  capturedAmountCents,
  successfulRefundedAmountCents,
}) {
  return Math.max(
    0,
    Number(capturedAmountCents || 0) -
      Number(successfulRefundedAmountCents || 0),
  );
}

function cancellationActor(user) {
  return {
    actorType: user?.role === "admin" ? "admin" : "staff",
    userId: user?.userId || user?.staffId || user?.id || null,
    name: user?.name || null,
    email: user?.email || null,
    role: user?.role || null,
  };
}

function refundActor(user) {
  const actor = cancellationActor(user);
  const { actorType: _actorType, ...snapshot } = actor;
  return snapshot;
}

function normalizeNotes(value) {
  if (value === null || value === undefined) return null;
  const notes = String(value).trim().replace(/\s+/g, " ");
  return notes || null;
}

function assertCancellationInput({ outcome, reason, notes }) {
  if (!RESERVATION_CANCELLATION_OUTCOMES.includes(outcome)) {
    throw new ReservationCancellationError("Invalid cancellation outcome.");
  }
  if (!RESERVATION_CANCELLATION_REASONS.includes(reason)) {
    throw new ReservationCancellationError(
      "A valid cancellation reason is required.",
    );
  }
  const normalizedNotes = normalizeNotes(notes);
  if (normalizedNotes && normalizedNotes.length > 500) {
    throw new ReservationCancellationError(
      "Cancellation notes cannot exceed 500 characters.",
    );
  }
  return normalizedNotes;
}

export function buildReservationCancellationIdempotencyKey({
  businessId,
  reservationId,
  clientKey,
}) {
  const normalizedClientKey = String(clientKey || "").trim();
  if (
    normalizedClientKey.length < 8 ||
    normalizedClientKey.length > 200
  ) {
    throw new ReservationCancellationError(
      "A valid Idempotency-Key header is required.",
      { code: "IDEMPOTENCY_KEY_REQUIRED" },
    );
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${businessId}:${reservationId}:${normalizedClientKey}`)
    .digest("hex");
  return `reservation-cancellation/${digest}`;
}

function requestFingerprint({ outcome, amountCents, reason, notes }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        outcome,
        amountCents,
        reason,
        notes: notes || null,
      }),
    )
    .digest("hex");
}

async function successfulRefundTotal({
  businessId,
  reservationId,
  refundModel,
}) {
  const rows = await refundModel
    .find({
      businessId,
      reservationId,
      status: "succeeded",
    })
    .lean();
  return rows.reduce(
    (sum, row) => sum + Number(row.successfulAmountCents || 0),
    0,
  );
}

function normalizeStripeRefundStatus(status) {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  return "pending";
}

function stripeReason(reason) {
  if (reason === "duplicate_booking") return "duplicate";
  if (reason === "guest_request") return "requested_by_customer";
  return undefined;
}

async function sendRefundNotificationOnce({
  refund,
  reservation,
  reservationModel,
  businessModel,
  refundModel,
  sendRefundEmail,
  now,
}) {
  if (!reservation?.email) return false;

  return dispatchRefundConfirmation({
    businessId: refund.businessId,
    refundId: refund.refundId,
    directSend: () => deliverRefundEmailDirect({
      refund,
      reservation,
      reservationModel,
      refundModel,
      businessModel,
      sendRefundEmail,
      now,
    }),
  });
}

export async function reconcileReservationRefund({
  refundRecord,
  providerRefund,
  reservationModel = Reservation,
  refundModel = ReservationRefund,
  businessModel = Business,
  sendRefundEmail = sendReservationRefundEmail,
  now = new Date(),
}) {
  const providerStatus = normalizeStripeRefundStatus(providerRefund?.status);
  const providerCreatedAt = providerRefund?.created
    ? new Date(providerRefund.created * 1000)
    : null;

  if (refundRecord.status === "succeeded") {
    const reservation = await reservationModel.findOne({
      _id: refundRecord.reservationId,
      businessId: refundRecord.businessId,
    });
    if (
      reservation?.status === "cancelled" &&
      reservation.cancellationIdempotencyKey === refundRecord.idempotencyKey
    ) {
      await sendRefundNotificationOnce({
        refund: refundRecord,
        reservation,
        reservationModel,
        businessModel,
        refundModel,
        sendRefundEmail,
        now,
      });
      return { refund: refundRecord, reservation, idempotent: true };
    }
  }

  if (providerStatus === "failed" || providerStatus === "cancelled") {
    const failedRefund = await refundModel.findOneAndUpdate(
      {
        _id: refundRecord._id,
        status: { $ne: "succeeded" },
      },
      {
        $set: {
          status: providerStatus,
          providerRefundId:
            providerRefund?.id || refundRecord.providerRefundId || null,
          providerCreatedAt,
          failureCode:
            providerRefund?.failure_reason ||
            providerRefund?.failure_code ||
            providerStatus,
          failureMessage:
            providerRefund?.failure_reason ||
            `Stripe refund ${providerStatus}.`,
          ...(providerStatus === "failed"
            ? { failedAt: now }
            : { cancelledAt: now }),
        },
      },
      { new: true },
    );
    await reservationModel.updateOne(
      {
        _id: refundRecord.reservationId,
        businessId: refundRecord.businessId,
        activeRefundId: refundRecord.refundId,
      },
      { $set: { activeRefundId: null } },
    );
    return { refund: failedRefund, reservation: null };
  }

  if (providerStatus === "pending") {
    const pendingRefund = await refundModel.findOneAndUpdate(
      { _id: refundRecord._id, status: "pending" },
      {
        $set: {
          providerRefundId:
            providerRefund?.id || refundRecord.providerRefundId || null,
          providerCreatedAt,
        },
      },
      { new: true },
    );
    return { refund: pendingRefund || refundRecord, reservation: null };
  }

  const succeededRefund = await refundModel.findOneAndUpdate(
    {
      _id: refundRecord._id,
      status: { $ne: "succeeded" },
    },
    {
      $set: {
        status: "succeeded",
        providerRefundId:
          providerRefund?.id || refundRecord.providerRefundId || null,
        providerCreatedAt,
        successfulAmountCents: refundRecord.requestedAmountCents,
        succeededAt: now,
        failureCode: null,
        failureMessage: null,
      },
    },
    { new: true },
  );
  const finalRefund = succeededRefund || refundRecord;
  const reservation = await reservationModel.findOne({
    _id: finalRefund.reservationId,
    businessId: finalRefund.businessId,
  });
  if (!reservation) {
    throw new ReservationCancellationError(
      "The refund succeeded but reservation reconciliation requires support.",
      { status: 500, code: "REFUND_RECONCILIATION_REQUIRED" },
    );
  }

  const ledgerRefundedCents = await successfulRefundTotal({
    businessId: finalRefund.businessId,
    reservationId: finalRefund.reservationId,
    refundModel,
  });
  const successfulRefundedCents = Math.max(
    ledgerRefundedCents,
    Number(reservation.refundedAmountCents || 0),
  );
  const capturedAmountCents = getReservationCapturedAmountCents(reservation);
  const paymentStatus =
    successfulRefundedCents >= capturedAmountCents
      ? "refunded"
      : "partially_refunded";
  const cancelledBy = {
    actorType: "staff",
    ...finalRefund.requestedBy,
  };

  const finalizedReservation = await reservationModel.findOneAndUpdate(
    {
      _id: reservation._id,
      businessId: finalRefund.businessId,
      $or: [
        {
          status: "confirmed",
          activeRefundId: finalRefund.refundId,
        },
        {
          status: "cancelled",
          cancellationIdempotencyKey: finalRefund.idempotencyKey,
        },
      ],
    },
    {
      $set: {
        status: "cancelled",
        paymentStatus,
        cancelledAt: reservation.cancelledAt || now,
        cancelledBy: reservation.cancelledBy || cancelledBy,
        cancellationReason: finalRefund.reason,
        cancellationNotes: finalRefund.notes,
        cancellationOutcome:
          finalRefund.type === "full" ? "full_refund" : "partial_refund",
        cancellationIdempotencyKey: finalRefund.idempotencyKey,
        cancellationOriginalPaidAmountCents: capturedAmountCents,
        cancellationRefundAmountCents: successfulRefundedCents,
        refundedAmountCents: successfulRefundedCents,
        lastRefundAt: now,
        activeRefundId: null,
      },
    },
    { new: true, runValidators: true },
  );
  if (!finalizedReservation) {
    throw new ReservationCancellationError(
      "The refund succeeded but the reservation changed before reconciliation. Support intervention is required.",
      { status: 500, code: "REFUND_RECONCILIATION_REQUIRED" },
    );
  }

  const emailDelivery = await sendRefundNotificationOnce({
    refund: finalRefund,
    reservation: finalizedReservation,
    reservationModel,
    businessModel,
    refundModel,
    sendRefundEmail,
    now,
  });

  return {
    refund: finalRefund,
    reservation: finalizedReservation,
    emailSent:
      emailDelivery?.mode === "direct" && Boolean(emailDelivery.success),
    emailQueued:
      emailDelivery?.mode === "queued" && Boolean(emailDelivery.queued),
  };
}

export async function reconcileStripeReservationRefund({
  providerRefund,
  reservationModel = Reservation,
  refundModel = ReservationRefund,
  businessModel = Business,
  sendRefundEmail = sendReservationRefundEmail,
  now = new Date(),
}) {
  const metadata = providerRefund?.metadata || {};
  let refundRecord = providerRefund?.id
    ? await refundModel.findOne({ providerRefundId: providerRefund.id })
    : null;
  if (!refundRecord && metadata.quickServeRefundId) {
    refundRecord = await refundModel.findOne({
      refundId: metadata.quickServeRefundId,
      businessId: metadata.businessId,
      reservationId: metadata.reservationId,
    });
  }
  if (!refundRecord) return { ignored: true };

  if (
    metadata.businessId &&
    metadata.businessId !== refundRecord.businessId
  ) {
    throw new ReservationCancellationError(
      "Stripe refund tenant metadata does not match the stored refund.",
      { status: 400, code: "REFUND_METADATA_MISMATCH" },
    );
  }
  if (
    metadata.quickServeRefundId &&
    metadata.quickServeRefundId !== refundRecord.refundId
  ) {
    throw new ReservationCancellationError(
      "Stripe refund metadata does not match the stored refund operation.",
      { status: 400, code: "REFUND_METADATA_MISMATCH" },
    );
  }
  if (
    metadata.reservationId &&
    String(metadata.reservationId) !==
      String(refundRecord.reservationId)
  ) {
    throw new ReservationCancellationError(
      "Stripe refund reservation metadata does not match the stored refund.",
      { status: 400, code: "REFUND_METADATA_MISMATCH" },
    );
  }
  if (
    providerRefund.payment_intent &&
    providerRefund.payment_intent !== refundRecord.providerPaymentId
  ) {
    throw new ReservationCancellationError(
      "Stripe refund payment identifier does not match the stored refund.",
      { status: 400, code: "REFUND_PAYMENT_MISMATCH" },
    );
  }

  return reconcileReservationRefund({
    refundRecord,
    providerRefund,
    reservationModel,
    refundModel,
    businessModel,
    sendRefundEmail,
    now,
  });
}

async function createOrLoadRefund({
  refundModel,
  values,
}) {
  try {
    return { refund: await refundModel.create(values), existing: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await refundModel.findOne({
      idempotencyKey: values.idempotencyKey,
    });
    if (!existing) throw error;
    return { refund: existing, existing: true };
  }
}

export async function cancelHotelReservation({
  businessId,
  reservationId,
  user,
  outcome,
  refundAmountCents,
  reason,
  notes,
  clientIdempotencyKey,
  stripeClient,
  reservationModel = Reservation,
  refundModel = ReservationRefund,
  businessModel = Business,
  sendRefundEmail = sendReservationRefundEmail,
  now = new Date(),
}) {
  const normalizedNotes = assertCancellationInput({ outcome, reason, notes });
  if (
    outcome !== "partial_refund" &&
    refundAmountCents !== undefined &&
    refundAmountCents !== null
  ) {
    throw new ReservationCancellationError(
      "A refund amount is allowed only for a partial refund.",
      { code: "UNEXPECTED_REFUND_AMOUNT" },
    );
  }
  const idempotencyKey = buildReservationCancellationIdempotencyKey({
    businessId,
    reservationId,
    clientKey: clientIdempotencyKey,
  });

  let reservation = await reservationModel.findOne({
    _id: reservationId,
    businessId,
  });
  if (!reservation) {
    throw new ReservationCancellationError("Reservation not found.", {
      status: 404,
      code: "RESERVATION_NOT_FOUND",
    });
  }
  if (!reservation.checkInDate) {
    throw new ReservationCancellationError(
      "This operation is only available for hotel reservations.",
    );
  }
  if (
    reservation.status === "cancelled" &&
    reservation.cancellationIdempotencyKey === idempotencyKey
  ) {
    const existingRefund = await refundModel.findOne({ idempotencyKey });
    return {
      reservation,
      refund: existingRefund,
      idempotent: true,
      pending: existingRefund?.status === "pending",
    };
  }

  const isPaid = PAID_PAYMENT_STATUSES.has(reservation.paymentStatus);
  if (!isPaid) {
    if (outcome !== "cancel_unpaid") {
      throw new ReservationCancellationError(
        "Unpaid reservations must use the unpaid cancellation outcome.",
      );
    }
    if (!CANCELLABLE_UNPAID_STATUSES.has(reservation.status)) {
      throw new ReservationCancellationError(
        `Reservation cannot be cancelled from ${reservation.status}.`,
        { status: 409, code: "INVALID_RESERVATION_STATE" },
      );
    }
    const cancelled = await reservationModel.findOneAndUpdate(
      {
        _id: reservation._id,
        businessId,
        status: reservation.status,
        activeRefundId: null,
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: cancellationActor(user),
          cancellationReason: reason,
          cancellationNotes: normalizedNotes,
          cancellationOutcome: "unpaid",
          cancellationIdempotencyKey: idempotencyKey,
          cancellationOriginalPaidAmountCents: 0,
          cancellationRefundAmountCents: 0,
        },
      },
      { new: true, runValidators: true },
    );
    if (!cancelled) {
      throw new ReservationCancellationError(
        "The reservation changed before it could be cancelled.",
        { status: 409, code: "RESERVATION_CHANGED" },
      );
    }
    return { reservation: cancelled, refund: null, pending: false };
  }

  if (!canRefundReservation(user)) {
    throw new ReservationCancellationError(
      "Owner or co-owner authorization is required for paid reservation cancellation.",
      { status: 403, code: "REFUND_FORBIDDEN" },
    );
  }
  if (reservation.status !== "confirmed") {
    throw new ReservationCancellationError(
      `Paid reservation cannot be cancelled from ${reservation.status}.`,
      { status: 409, code: "INVALID_RESERVATION_STATE" },
    );
  }

  const capturedAmountCents = getReservationCapturedAmountCents(reservation);
  if (capturedAmountCents <= 0) {
    throw new ReservationCancellationError(
      "The captured payment amount is unavailable.",
      { status: 409, code: "CAPTURED_AMOUNT_UNAVAILABLE" },
    );
  }

  if (outcome === "no_refund") {
    const cancelled = await reservationModel.findOneAndUpdate(
      {
        _id: reservation._id,
        businessId,
        status: "confirmed",
        paymentStatus: reservation.paymentStatus,
        activeRefundId: null,
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: cancellationActor(user),
          cancellationReason: reason,
          cancellationNotes: normalizedNotes,
          cancellationOutcome: "no_refund",
          cancellationIdempotencyKey: idempotencyKey,
          cancellationOriginalPaidAmountCents: capturedAmountCents,
          cancellationRefundAmountCents: Number(
            reservation.refundedAmountCents || 0,
          ),
        },
      },
      { new: true, runValidators: true },
    );
    if (!cancelled) {
      throw new ReservationCancellationError(
        "The reservation changed before it could be cancelled.",
        { status: 409, code: "RESERVATION_CHANGED" },
      );
    }
    return { reservation: cancelled, refund: null, pending: false };
  }

  if (!["full_refund", "partial_refund"].includes(outcome)) {
    throw new ReservationCancellationError(
      "A paid reservation requires an explicit payment handling outcome.",
    );
  }
  if (!REFUNDABLE_PAYMENT_STATUSES.has(reservation.paymentStatus)) {
    throw new ReservationCancellationError(
      "This payment has no refundable balance.",
      { status: 409, code: "PAYMENT_NOT_REFUNDABLE" },
    );
  }
  if (!reservation.stripePaymentIntentId) {
    throw new ReservationCancellationError(
      "The original Stripe payment identifier is unavailable.",
      { status: 409, code: "PROVIDER_PAYMENT_ID_UNAVAILABLE" },
    );
  }
  if (!stripeClient?.refunds?.create) {
    throw new ReservationCancellationError(
      "Stripe refunds are not configured.",
      { status: 503, code: "REFUND_PROVIDER_UNAVAILABLE" },
    );
  }

  const ledgerRefundedCents = await successfulRefundTotal({
    businessId,
    reservationId: reservation._id,
    refundModel,
  });
  const successfulRefundedAmountCents = Math.max(
    ledgerRefundedCents,
    Number(reservation.refundedAmountCents || 0),
  );
  const remainingRefundableAmountCents =
    getRemainingRefundableAmountCents({
      capturedAmountCents,
      successfulRefundedAmountCents,
    });
  const requestedAmountCents =
    outcome === "full_refund"
      ? remainingRefundableAmountCents
      : refundAmountCents;
  if (
    !Number.isSafeInteger(requestedAmountCents) ||
    requestedAmountCents <= 0 ||
    requestedAmountCents > remainingRefundableAmountCents
  ) {
    throw new ReservationCancellationError(
      "Refund amount must be greater than zero and cannot exceed the remaining refundable amount.",
      {
        code: "INVALID_REFUND_AMOUNT",
        details: { remainingRefundableAmountCents },
      },
    );
  }

  const fingerprint = requestFingerprint({
    outcome,
    amountCents: requestedAmountCents,
    reason,
    notes: normalizedNotes,
  });
  const refundId = `RF-${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
  const { refund, existing } = await createOrLoadRefund({
    refundModel,
    values: {
      refundId,
      businessId,
      reservationId: reservation._id,
      paymentProvider: "stripe",
      providerPaymentId: reservation.stripePaymentIntentId,
      connectedAccountId: reservation.stripeConnectedAccountId || null,
      idempotencyKey,
      requestFingerprint: fingerprint,
      originalPaidAmountCents: capturedAmountCents,
      requestedAmountCents,
      currency: String(reservation.currency || "").toLowerCase(),
      type: outcome === "full_refund" ? "full" : "partial",
      reason,
      notes: normalizedNotes,
      requestedBy: refundActor(user),
      requestedAt: now,
    },
  });
  if (existing && refund.requestFingerprint !== fingerprint) {
    throw new ReservationCancellationError(
      "The idempotency key was already used for a different cancellation request.",
      { status: 409, code: "IDEMPOTENCY_CONFLICT" },
    );
  }
  if (refund.status === "succeeded") {
    return reconcileReservationRefund({
      refundRecord: refund,
      providerRefund: {
        id: refund.providerRefundId,
        payment_intent: refund.providerPaymentId,
        status: "succeeded",
      },
      reservationModel,
      refundModel,
      businessModel,
      sendRefundEmail,
      now,
    });
  }
  if (refund.status === "failed" || refund.status === "cancelled") {
    throw new ReservationCancellationError(
      "This refund attempt did not succeed. Submit a new request to retry.",
      { status: 409, code: "REFUND_RETRY_REQUIRES_NEW_KEY" },
    );
  }

  const lock = await reservationModel.findOneAndUpdate(
    {
      _id: reservation._id,
      businessId,
      status: "confirmed",
      paymentStatus: reservation.paymentStatus,
      $or: [
        { activeRefundId: null },
        { activeRefundId: refund.refundId },
      ],
    },
    { $set: { activeRefundId: refund.refundId } },
    { new: true, runValidators: true },
  );
  if (!lock) {
    if (!existing) {
      await refundModel.updateOne(
        { _id: refund._id, status: "pending" },
        {
          $set: {
            status: "cancelled",
            cancelledAt: now,
            failureCode: "CONCURRENT_RESERVATION_CHANGE",
            failureMessage:
              "Another lifecycle or refund operation already holds the reservation.",
          },
        },
      );
    }
    throw new ReservationCancellationError(
      "Another reservation or refund operation is already in progress.",
      { status: 409, code: "CONCURRENT_OPERATION" },
    );
  }
  reservation = lock;

  let providerRefund;
  try {
    providerRefund = await stripeClient.refunds.create(
      {
        payment_intent: reservation.stripePaymentIntentId,
        amount: requestedAmountCents,
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: {
          quickServeRefundId: refund.refundId,
          reservationId: String(reservation._id),
          businessId,
        },
        ...(stripeReason(reason)
          ? { reason: stripeReason(reason) }
          : {}),
      },
      { idempotencyKey },
    );
  } catch (error) {
    await refundModel.updateOne(
      { _id: refund._id, status: "pending" },
      {
        $set: {
          status: "failed",
          failedAt: now,
          failureCode: error?.code || error?.type || "stripe_error",
          failureMessage: String(
            error?.message || "Stripe refund request failed.",
          ).slice(0, 500),
        },
      },
    );
    await reservationModel.updateOne(
      {
        _id: reservation._id,
        businessId,
        activeRefundId: refund.refundId,
      },
      { $set: { activeRefundId: null } },
    );
    throw new ReservationCancellationError(
      "Stripe did not accept the refund. The reservation remains confirmed.",
      { status: 502, code: "REFUND_PROVIDER_FAILED" },
    );
  }

  const reconciled = await reconcileReservationRefund({
    refundRecord: refund,
    providerRefund,
    reservationModel,
    refundModel,
    businessModel,
    sendRefundEmail,
    now,
  });
  return {
    ...reconciled,
    reservation: reconciled.reservation || reservation,
    pending: normalizeStripeRefundStatus(providerRefund.status) === "pending",
  };
}
