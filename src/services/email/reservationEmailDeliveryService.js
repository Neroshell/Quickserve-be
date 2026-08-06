import crypto from "node:crypto";
import Business from "../../models/Business.js";
import EmailDelivery from "../../models/EmailDelivery.js";
import Reservation from "../../models/Reservation.js";
import {
  EmailDeliveryError,
  sendReservationCancelledEmail,
  sendReservationConfirmedEmail,
  sendReservationArrivalReminderEmail,
  sendReservationRequestEmail,
  sendReservationRequestReceivedEmail,
} from "../../utils/emailService.js";
import { buildEmailJobId, EMAIL_JOB_NAMES } from "../../queues/index.js";
import {
  createReservationArrivalToken,
  hashReservationArrivalToken,
} from "../reservationArrivalTokenService.js";

const CLAIM_TTL_MS = 5 * 60 * 1000;

function safeErrorCode(error) {
  return String(error?.code || error?.name || "email_delivery_failed")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 200);
}

function normalizeDeliveryVersion(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? String(timestamp) : "1";
}

function reservationDeliveryIdentity({
  jobName,
  businessId,
  reservationId,
  deliveryVersion,
}) {
  const normalizedVersion = normalizeDeliveryVersion(deliveryVersion);
  const deliveryId = buildEmailJobId(jobName, {
    businessId,
    reservationId,
    deliveryId: "pending",
    deliveryVersion: normalizedVersion,
  });
  return { deliveryId, deliveryVersion: normalizedVersion };
}

export async function ensureReservationEmailIntent({
  jobName,
  businessId,
  reservationId,
  deliveryVersion,
  scheduledFor = null,
  deliveryModel = EmailDelivery,
  now = new Date(),
}) {
  const identity = reservationDeliveryIdentity({
    jobName,
    businessId,
    reservationId,
    deliveryVersion,
  });
  const values = {
    deliveryId: identity.deliveryId,
    businessId,
    entityType: "reservation",
    entityId: String(reservationId),
    jobName,
    deliveryVersion: identity.deliveryVersion,
    status: "pending",
    retryable: true,
    enqueuedAt: null,
    enqueueError: null,
    scheduledFor,
    createdAt: now,
  };

  try {
    return await deliveryModel.findOneAndUpdate(
      { deliveryId: identity.deliveryId, businessId },
      { $setOnInsert: values },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return deliveryModel.findOne({ deliveryId: identity.deliveryId, businessId });
  }
}

export async function markReservationEmailEnqueued({
  deliveryId,
  businessId,
  deliveryModel = EmailDelivery,
  now = new Date(),
}) {
  await deliveryModel.updateOne(
    { deliveryId, businessId, status: { $ne: "sent" } },
    {
      $set: {
        enqueuedAt: now,
        enqueueError: null,
      },
    },
  );
}

export async function markReservationEmailEnqueueFailed({
  deliveryId,
  businessId,
  error,
  deliveryModel = EmailDelivery,
}) {
  const errorCode = safeErrorCode(error);
  await deliveryModel.updateOne(
    { deliveryId, businessId, status: { $ne: "sent" } },
    {
      $set: {
        status: "pending",
        enqueueError: errorCode,
        lastError: errorCode,
        retryable: true,
      },
    },
  );
}

export async function markExistingReservationEmailDirectlySent({
  jobName,
  businessId,
  reservationId,
  deliveryVersion,
  deliveryModel = EmailDelivery,
  now = new Date(),
}) {
  const { deliveryId } = reservationDeliveryIdentity({
    jobName,
    businessId,
    reservationId,
    deliveryVersion,
  });
  await deliveryModel.updateOne(
    { deliveryId, businessId, status: { $ne: "sent" } },
    {
      $set: {
        status: "sent",
        sentAt: now,
        claimedAt: null,
        claimId: null,
        lastError: null,
        retryable: false,
      },
    },
  );
}

export async function claimReservationEmailDelivery({
  deliveryId,
  businessId,
  deliveryModel = EmailDelivery,
  now = new Date(),
  claimId = crypto.randomUUID(),
}) {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  return deliveryModel.findOneAndUpdate(
    {
      deliveryId,
      businessId,
      sentAt: null,
      $or: [
        {
          status: { $in: ["pending", "failed"] },
          retryable: { $ne: false },
        },
        {
          status: "processing",
          claimedAt: { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        status: "processing",
        claimedAt: now,
        claimId,
        lastError: null,
      },
      $inc: { attemptCount: 1 },
    },
    { new: true },
  );
}

export async function completeReservationEmailDelivery({
  deliveryId,
  businessId,
  claimId,
  providerMessageId,
  deliveryModel = EmailDelivery,
  now = new Date(),
}) {
  return deliveryModel.findOneAndUpdate(
    { deliveryId, businessId, status: "processing", claimId },
    {
      $set: {
        status: "sent",
        sentAt: now,
        providerMessageId: providerMessageId || null,
        lastError: null,
        retryable: false,
        claimedAt: null,
        claimId: null,
      },
    },
    { new: true },
  );
}

export async function failReservationEmailDelivery({
  deliveryId,
  businessId,
  claimId,
  error,
  deliveryModel = EmailDelivery,
}) {
  await deliveryModel.updateOne(
    { deliveryId, businessId, status: "processing", claimId },
    {
      $set: {
        status: "failed",
        claimedAt: null,
        claimId: null,
        lastError: safeErrorCode(error),
        retryable: error?.retryable !== false,
      },
    },
  );
}

export async function cancelReservationEmailDelivery({
  deliveryId,
  businessId,
  claimId,
  reason,
  deliveryModel = EmailDelivery,
}) {
  return deliveryModel.findOneAndUpdate(
    { deliveryId, businessId, status: "processing", claimId },
    {
      $set: {
        status: "cancelled",
        claimedAt: null,
        claimId: null,
        lastError: safeErrorCode({ code: reason }),
        retryable: false,
      },
    },
    { new: true },
  );
}

function permanentError(code) {
  return new EmailDeliveryError("Reservation email cannot be delivered.", {
    code,
    retryable: false,
  });
}

function reservationStatusIsCurrent(jobName, reservation) {
  if (jobName === EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED) {
    return reservation.status === "confirmed";
  }
  if (jobName === EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED) {
    return ["cancelled", "declined"].includes(reservation.status);
  }
  if (jobName === EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER) {
    return reservation.status === "confirmed";
  }
  return true;
}

function senderForReservationJob(jobName, senders) {
  const map = {
    [EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER]: senders.sendOwner,
    [EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST]: senders.sendGuest,
    [EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED]: senders.sendConfirmed,
    [EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED]: senders.sendCancelled,
    [EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER]: senders.sendArrivalReminder,
  };
  return map[jobName];
}

async function resolveLean(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

export async function processReservationEmailDelivery(
  job,
  {
    reservationModel = Reservation,
    businessModel = Business,
    deliveryModel = EmailDelivery,
    senders = {
      sendOwner: sendReservationRequestEmail,
      sendGuest: sendReservationRequestReceivedEmail,
      sendConfirmed: sendReservationConfirmedEmail,
      sendCancelled: sendReservationCancelledEmail,
      sendArrivalReminder: sendReservationArrivalReminderEmail,
    },
    now = new Date(),
  } = {},
) {
  const { businessId, reservationId, deliveryId } = job.data;
  const claim = await claimReservationEmailDelivery({
    deliveryId,
    businessId,
    deliveryModel,
    now,
  });
  if (!claim) return { skipped: true, reason: "not_claimed" };

  try {
    const isArrivalReminder =
      job.name === EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER;
    let reservationQuery = reservationModel.findOne({
      _id: reservationId,
      businessId,
    });
    if (isArrivalReminder && typeof reservationQuery?.select === "function") {
      reservationQuery = reservationQuery.select("+arrivalTokenHash");
    }
    const reservation = await reservationQuery;
    if (!reservation) throw permanentError("reservation_not_found");
    if (reservation.checkInDate) {
      if (isArrivalReminder) {
        await cancelReservationEmailDelivery({
          deliveryId,
          businessId,
          claimId: claim.claimId,
          reason: "lodging_email_not_queueable",
          deliveryModel,
        });
        return { skipped: true, reason: "lodging_email_not_queueable" };
      }
      throw permanentError("lodging_email_not_queueable");
    }
    if (!reservationStatusIsCurrent(job.name, reservation)) {
      if (isArrivalReminder) {
        await cancelReservationEmailDelivery({
          deliveryId,
          businessId,
          claimId: claim.claimId,
          reason: "stale_reservation_status",
          deliveryModel,
        });
        return { skipped: true, reason: "stale_reservation_status" };
      }
      throw permanentError("stale_reservation_status");
    }

    const business = await resolveLean(businessModel.findOne({ businessId }));
    if (!business) throw permanentError("business_not_found");

    if (isArrivalReminder && business.settings?.arrivalReminderEnabled === false) {
      await cancelReservationEmailDelivery({
        deliveryId,
        businessId,
        claimId: claim.claimId,
        reason: "business_reminder_disabled",
        deliveryModel,
      });
      return { skipped: true, reason: "business_reminder_disabled" };
    }

    if (
      isArrivalReminder &&
      (!reservation.arrivalTokenExpiresAt ||
        reservation.arrivalTokenExpiresAt <= now)
    ) {
      await cancelReservationEmailDelivery({
        deliveryId,
        businessId,
        claimId: claim.claimId,
        reason: "arrival_link_expired",
        deliveryModel,
      });
      return { skipped: true, reason: "arrival_link_expired" };
    }

    const sender = senderForReservationJob(job.name, senders);
    if (!sender) throw permanentError("unsupported_reservation_email_job");

    const reservationObject = reservation.toObject
      ? reservation.toObject()
      : reservation;
    const isOwnerNotification =
      job.name === EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER;
    const recipient = isOwnerNotification
      ? business.contactEmail || business.ownerEmail
      : reservation.email;
    if (!recipient) throw permanentError("recipient_missing");

    let arrivalUrl;
    let viewReservationUrl;
    if (isArrivalReminder) {
      const arrivalToken = createReservationArrivalToken(reservation);
      if (
        !reservation.arrivalTokenHash ||
        hashReservationArrivalToken(arrivalToken) !== reservation.arrivalTokenHash
      ) {
        await cancelReservationEmailDelivery({
          deliveryId,
          businessId,
          claimId: claim.claimId,
          reason: "arrival_token_scope_changed",
          deliveryModel,
        });
        return { skipped: true, reason: "arrival_token_scope_changed" };
      }
      const frontendBaseUrl =
        process.env.FRONTEND_BASE_URL || "http://localhost:3000";
      arrivalUrl = `${frontendBaseUrl}/reservation/arrival?token=${encodeURIComponent(arrivalToken)}`;
      viewReservationUrl = `${arrivalUrl}&view=1`;
    }

    const result = await sender({
      to: recipient,
      businessName: business.displayName || business.name,
      businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
      primaryColor: business.branding?.primaryColor,
      reservation: reservationObject,
      arrivalUrl,
      viewReservationUrl,
      idempotencyKey: deliveryId,
      returnResult: true,
    });
    if (!result || result.success !== true) {
      throw new EmailDeliveryError("Provider did not accept the email.", {
        code: "provider_not_accepted",
        retryable: true,
      });
    }

    await completeReservationEmailDelivery({
      deliveryId,
      businessId,
      claimId: claim.claimId,
      providerMessageId: result.messageId,
      deliveryModel,
      now,
    });
    return { success: true, messageId: result.messageId || null };
  } catch (error) {
    await failReservationEmailDelivery({
      deliveryId,
      businessId,
      claimId: claim.claimId,
      error,
      deliveryModel,
    });
    throw error;
  }
}

export { normalizeDeliveryVersion, safeErrorCode };
