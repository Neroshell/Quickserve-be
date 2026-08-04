import crypto from "node:crypto";
import Business from "../../models/Business.js";
import Reservation from "../../models/Reservation.js";
import ReservationRefund from "../../models/ReservationRefund.js";
import {
  EmailDeliveryError,
  sendReservationRefundEmail,
} from "../../utils/emailService.js";

const CLAIM_TTL_MS = 5 * 60 * 1000;

function safeErrorCode(error) {
  return String(error?.code || error?.name || "refund_email_failed")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 200);
}

async function resolveLean(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

export async function ensureRefundEmailIntent({
  businessId,
  refundId,
  refundModel = ReservationRefund,
}) {
  const intent = await refundModel.findOneAndUpdate(
    {
      businessId,
      refundId,
      status: "succeeded",
      customerEmailSentAt: null,
      $or: [
        { customerEmailStatus: { $exists: false } },
        { customerEmailStatus: null },
        { customerEmailStatus: "pending" },
        {
          customerEmailStatus: "failed",
          customerEmailRetryable: { $ne: false },
        },
      ],
    },
    {
      $set: {
        customerEmailStatus: "pending",
        customerEmailError: null,
        customerEmailRetryable: true,
      },
    },
    { new: true },
  );
  if (intent) return intent;
  return refundModel.findOne({ businessId, refundId });
}

export async function markRefundEmailEnqueued({
  businessId,
  refundId,
  refundModel = ReservationRefund,
  now = new Date(),
}) {
  await refundModel.updateOne(
    {
      businessId,
      refundId,
      customerEmailSentAt: null,
    },
    {
      $set: {
        customerEmailEnqueuedAt: now,
        customerEmailEnqueueError: null,
      },
    },
  );
}

export async function markRefundEmailEnqueueFailed({
  businessId,
  refundId,
  error,
  refundModel = ReservationRefund,
}) {
  const errorCode = safeErrorCode(error);
  await refundModel.updateOne(
    { businessId, refundId, customerEmailSentAt: null },
    {
      $set: {
        customerEmailStatus: "pending",
        customerEmailEnqueueError: errorCode,
        customerEmailError: errorCode,
        customerEmailRetryable: true,
      },
    },
  );
}

// This is the existing refund email lease, extracted so both the direct
// rollback path and the BullMQ worker use the same atomic claim.
export async function claimRefundEmailDelivery({
  businessId,
  refundId,
  refundModel = ReservationRefund,
  now = new Date(),
  claimId = crypto.randomUUID(),
  retryableOnly = false,
}) {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  return refundModel.findOneAndUpdate(
    {
      businessId,
      refundId,
      status: "succeeded",
      customerEmailSentAt: null,
      ...(retryableOnly ? { customerEmailRetryable: { $ne: false } } : {}),
      $or: [
        { customerEmailSendingAt: null },
        { customerEmailSendingAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        customerEmailStatus: "processing",
        customerEmailSendingAt: now,
        customerEmailClaimId: claimId,
        customerEmailError: null,
      },
      $inc: { customerEmailAttemptCount: 1 },
    },
    { new: true },
  );
}

export async function completeRefundEmailDelivery({
  businessId,
  refundId,
  claimId,
  providerMessageId,
  refundModel = ReservationRefund,
  now = new Date(),
}) {
  return refundModel.findOneAndUpdate(
    {
      businessId,
      refundId,
      customerEmailStatus: "processing",
      customerEmailClaimId: claimId,
    },
    {
      $set: {
        customerEmailStatus: "sent",
        customerEmailSentAt: now,
        customerEmailSendingAt: null,
        customerEmailClaimId: null,
        customerEmailError: null,
        customerEmailRetryable: false,
        customerEmailProviderMessageId: providerMessageId || null,
      },
    },
    { new: true },
  );
}

export async function failRefundEmailDelivery({
  businessId,
  refundId,
  claimId,
  error,
  refundModel = ReservationRefund,
}) {
  await refundModel.updateOne(
    {
      businessId,
      refundId,
      customerEmailStatus: "processing",
      customerEmailClaimId: claimId,
    },
    {
      $set: {
        customerEmailStatus: "failed",
        customerEmailSendingAt: null,
        customerEmailClaimId: null,
        customerEmailError: safeErrorCode(error),
        customerEmailRetryable: error?.retryable !== false,
      },
    },
  );
}

async function loadRefundEmailContext({
  claim,
  reservation,
  reservationModel,
  businessModel,
}) {
  const resolvedReservation = reservation || await reservationModel.findOne({
    _id: claim.reservationId,
    businessId: claim.businessId,
  });
  if (!resolvedReservation) {
    throw new EmailDeliveryError("Refund reservation is unavailable.", {
      code: "reservation_not_found",
      retryable: false,
    });
  }
  if (!resolvedReservation.email) {
    throw new EmailDeliveryError("Refund recipient is missing.", {
      code: "recipient_missing",
      retryable: false,
    });
  }

  const business = await resolveLean(businessModel.findOne({
    businessId: claim.businessId,
  }));
  if (!business) {
    throw new EmailDeliveryError("Refund business is unavailable.", {
      code: "business_not_found",
      retryable: false,
    });
  }
  return { reservation: resolvedReservation, business };
}

function refundEmailArguments({ claim, reservation, business }) {
  return {
    to: reservation.email,
    businessName: business.displayName || business.name,
    businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
    primaryColor: business.branding?.primaryColor,
    reservation: reservation.toObject ? reservation.toObject() : reservation,
    refund: claim.toObject ? claim.toObject() : claim,
  };
}

export async function deliverRefundEmailDirect({
  refund,
  reservation,
  reservationModel = Reservation,
  refundModel = ReservationRefund,
  businessModel = Business,
  sendRefundEmail = sendReservationRefundEmail,
  now = new Date(),
}) {
  if (!reservation?.email) return false;
  const claim = await claimRefundEmailDelivery({
    businessId: refund.businessId,
    refundId: refund.refundId,
    refundModel,
    now,
  });
  if (!claim) return Boolean(refund.customerEmailSentAt);

  try {
    const context = await loadRefundEmailContext({
      claim,
      reservation,
      reservationModel,
      businessModel,
    });
    const sent = await sendRefundEmail(
      refundEmailArguments({ claim, ...context }),
    );
    if (!sent) {
      throw new EmailDeliveryError("Provider did not accept the refund email.", {
        code: "provider_not_accepted",
        retryable: true,
      });
    }
    const result = typeof sent === "object" ? sent : null;
    await completeRefundEmailDelivery({
      businessId: claim.businessId,
      refundId: claim.refundId,
      claimId: claim.customerEmailClaimId,
      providerMessageId: result?.messageId,
      refundModel,
      now,
    });
    return true;
  } catch (error) {
    await failRefundEmailDelivery({
      businessId: claim.businessId,
      refundId: claim.refundId,
      claimId: claim.customerEmailClaimId,
      error,
      refundModel,
    });
    return false;
  }
}

export async function processRefundEmailDelivery(
  job,
  {
    reservationModel = Reservation,
    refundModel = ReservationRefund,
    businessModel = Business,
    sendRefundEmail = sendReservationRefundEmail,
    now = new Date(),
  } = {},
) {
  const { businessId, refundId } = job.data;
  const claim = await claimRefundEmailDelivery({
    businessId,
    refundId,
    refundModel,
    now,
    retryableOnly: true,
  });
  if (!claim) return { skipped: true, reason: "not_claimed" };

  try {
    const context = await loadRefundEmailContext({
      claim,
      reservationModel,
      businessModel,
    });
    const result = await sendRefundEmail({
      ...refundEmailArguments({ claim, ...context }),
      returnResult: true,
    });
    if (!result || result.success !== true) {
      throw new EmailDeliveryError("Provider did not accept the refund email.", {
        code: "provider_not_accepted",
        retryable: true,
      });
    }
    await completeRefundEmailDelivery({
      businessId,
      refundId,
      claimId: claim.customerEmailClaimId,
      providerMessageId: result.messageId,
      refundModel,
      now,
    });
    return { success: true, messageId: result.messageId || null };
  } catch (error) {
    await failRefundEmailDelivery({
      businessId,
      refundId,
      claimId: claim.customerEmailClaimId,
      error,
      refundModel,
    });
    throw error;
  }
}

export { safeErrorCode as safeRefundEmailErrorCode };
