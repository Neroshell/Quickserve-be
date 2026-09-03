import { enqueueEmailJob, EMAIL_JOB_NAMES } from "../../queues/index.js";
import {
  ensureOrderReceiptIntent,
  markOrderReceiptEnqueued,
  markOrderReceiptEnqueueFailed,
} from "./orderReceiptDeliveryService.js";
import {
  ensureRefundEmailIntent,
  markRefundEmailEnqueued,
  markRefundEmailEnqueueFailed,
} from "./refundEmailDeliveryService.js";
import {
  ensureReservationEmailIntent,
  markExistingReservationEmailDirectlySent,
  markReservationEmailEnqueued,
  markReservationEmailEnqueueFailed,
} from "./reservationEmailDeliveryService.js";
import {
  ensureBillingEmailIntent,
  markBillingEmailEnqueued,
  markBillingEmailEnqueueFailed,
  processBillingEmailDelivery,
} from "./billingEmailDeliveryService.js";

export function isBullMqEmailsEnabled(env = process.env) {
  return env.BULLMQ_EMAILS_ENABLED === "true";
}

function safeErrorReason(error) {
  return error?.code || error?.name || "email_dispatch_failed";
}

async function dispatchDirect({ directSend, waitForDirect, entityId }) {
  if (typeof directSend !== "function") {
    return { mode: "direct", success: false, error: "direct_sender_missing" };
  }

  if (waitForDirect) {
    const success = await directSend();
    return { mode: "direct", success: Boolean(success) };
  }

  void Promise.resolve()
    .then(directSend)
    .catch((error) => {
      console.error("[EmailDispatch] Direct delivery failed", {
        entityId,
        reason: safeErrorReason(error),
      });
    });
  return { mode: "direct", dispatched: true };
}

export async function dispatchRestaurantReservationEmail({
  jobName,
  businessId,
  reservationId,
  deliveryVersion,
  directSend,
  waitForDirect = true,
  env = process.env,
  dependencies = {},
}) {
  if (!isBullMqEmailsEnabled(env)) {
    const markDirectSent = dependencies.markDirectSent ||
      markExistingReservationEmailDirectlySent;
    const trackedDirectSend = async () => {
      const success = await directSend();
      if (success) {
        await markDirectSent({
          jobName,
          businessId,
          reservationId,
          deliveryVersion,
        });
      }
      return success;
    };
    return dispatchDirect({
      directSend: trackedDirectSend,
      waitForDirect,
      entityId: reservationId,
    });
  }

  const ensureIntent = dependencies.ensureIntent || ensureReservationEmailIntent;
  const enqueue = dependencies.enqueue || enqueueEmailJob;
  const markEnqueued = dependencies.markEnqueued || markReservationEmailEnqueued;
  const markFailed = dependencies.markFailed || markReservationEmailEnqueueFailed;
  let intent;
  try {
    intent = await ensureIntent({
      jobName,
      businessId,
      reservationId,
      deliveryVersion,
    });
    if (!intent || intent.status === "sent" || intent.retryable === false) {
      return { mode: "queued", queued: false, reason: "delivery_not_eligible" };
    }

    const payload = {
      businessId,
      reservationId: String(reservationId),
      deliveryId: intent.deliveryId,
      deliveryVersion: intent.deliveryVersion,
    };
    const queued = await enqueue(jobName, payload, { env });
    await markEnqueued({ deliveryId: intent.deliveryId, businessId });
    return { mode: "queued", queued: true, jobId: queued.jobId };
  } catch (error) {
    if (intent?.deliveryId) {
      await markFailed({
        deliveryId: intent.deliveryId,
        businessId,
        error,
      }).catch(() => {});
    }
    console.error("[EmailDispatch] Reservation email enqueue failed", {
      queue: "email",
      jobName,
      entityId: String(reservationId),
      reason: safeErrorReason(error),
    });
    return { mode: "queued", queued: false, reason: "enqueue_failed" };
  }
}

export async function dispatchAutomaticOrderReceipt({
  businessId,
  orderId,
  directSend,
  waitForDirect = true,
  env = process.env,
  dependencies = {},
}) {
  if (!isBullMqEmailsEnabled(env)) {
    return dispatchDirect({ directSend, waitForDirect, entityId: orderId });
  }

  const ensureIntent = dependencies.ensureIntent || ensureOrderReceiptIntent;
  const enqueue = dependencies.enqueue || enqueueEmailJob;
  const markEnqueued = dependencies.markEnqueued || markOrderReceiptEnqueued;
  const markFailed = dependencies.markFailed || markOrderReceiptEnqueueFailed;
  let intent;
  try {
    intent = await ensureIntent({ businessId, orderId });
    if (
      !intent ||
      intent.receiptSent ||
      intent.receiptDeliveryStatus === "sent" ||
      intent.receiptDeliveryRetryable === false
    ) {
      return { mode: "queued", queued: false, reason: "delivery_not_eligible" };
    }

    const queued = await enqueue(
      EMAIL_JOB_NAMES.ORDER_RECEIPT,
      { businessId, orderId },
      { env },
    );
    await markEnqueued({ businessId, orderId });
    return { mode: "queued", queued: true, jobId: queued.jobId };
  } catch (error) {
    if (intent) {
      await markFailed({ businessId, orderId, error }).catch(() => {});
    }
    console.error("[EmailDispatch] Order receipt enqueue failed", {
      queue: "email",
      jobName: EMAIL_JOB_NAMES.ORDER_RECEIPT,
      entityId: orderId,
      reason: safeErrorReason(error),
    });
    return { mode: "queued", queued: false, reason: "enqueue_failed" };
  }
}

export async function dispatchRefundConfirmation({
  businessId,
  refundId,
  directSend,
  env = process.env,
  dependencies = {},
}) {
  if (!isBullMqEmailsEnabled(env)) {
    return dispatchDirect({ directSend, waitForDirect: true, entityId: refundId });
  }

  const ensureIntent = dependencies.ensureIntent || ensureRefundEmailIntent;
  const enqueue = dependencies.enqueue || enqueueEmailJob;
  const markEnqueued = dependencies.markEnqueued || markRefundEmailEnqueued;
  const markFailed = dependencies.markFailed || markRefundEmailEnqueueFailed;
  let intent;
  try {
    intent = await ensureIntent({ businessId, refundId });
    if (
      !intent ||
      intent.customerEmailSentAt ||
      intent.customerEmailStatus === "sent" ||
      intent.customerEmailRetryable === false
    ) {
      return { mode: "queued", queued: false, reason: "delivery_not_eligible" };
    }

    const queued = await enqueue(
      EMAIL_JOB_NAMES.REFUND_CONFIRMATION,
      { businessId, refundId },
      { env },
    );
    await markEnqueued({ businessId, refundId });
    return { mode: "queued", queued: true, jobId: queued.jobId };
  } catch (error) {
    if (intent) {
      await markFailed({ businessId, refundId, error }).catch(() => {});
    }
    console.error("[EmailDispatch] Refund email enqueue failed", {
      queue: "email",
      jobName: EMAIL_JOB_NAMES.REFUND_CONFIRMATION,
      entityId: refundId,
      reason: safeErrorReason(error),
    });
    return { mode: "queued", queued: false, reason: "enqueue_failed" };
  }
}

/**
 * Persists a billing-email intent before attempting either queue or direct
 * delivery. Queue/provider failure is deliberately returned to the caller
 * instead of throwing so authoritative billing state never depends on email.
 */
export async function dispatchBillingNotification({
  jobName,
  businessId,
  entityId,
  deliveryVersion = "1",
  recipient,
  metadata = {},
  env = process.env,
  dependencies = {},
}) {
  const ensureIntent = dependencies.ensureIntent || ensureBillingEmailIntent;
  const enqueue = dependencies.enqueue || enqueueEmailJob;
  const markEnqueued = dependencies.markEnqueued || markBillingEmailEnqueued;
  const markFailed = dependencies.markFailed || markBillingEmailEnqueueFailed;
  const processDelivery = dependencies.processDelivery || processBillingEmailDelivery;
  let intent;

  try {
    intent = await ensureIntent({
      jobName,
      businessId,
      entityId,
      deliveryVersion,
      recipient,
      metadata,
    });
    if (!intent || intent.status === "sent" || intent.retryable === false) {
      return { mode: "durable", queued: false, reason: "delivery_not_eligible" };
    }

    const payload = {
      businessId,
      entityId: String(entityId),
      deliveryId: intent.deliveryId,
      deliveryVersion: intent.deliveryVersion,
    };

    if (!isBullMqEmailsEnabled(env)) {
      const result = await processDelivery(
        { name: jobName, data: payload },
        dependencies.processor,
      );
      return { mode: "direct", success: result?.success === true };
    }

    const queued = await enqueue(jobName, payload, { env });
    await markEnqueued({ deliveryId: intent.deliveryId, businessId });
    return { mode: "queued", queued: true, jobId: queued.jobId };
  } catch (error) {
    if (intent?.deliveryId) {
      await markFailed({
        deliveryId: intent.deliveryId,
        businessId,
        error,
      }).catch(() => {});
    }
    console.error("[EmailDispatch] Billing email dispatch failed", {
      queue: "email",
      jobName,
      businessId,
      entityId: String(entityId),
      reason: safeErrorReason(error),
    });
    return {
      mode: isBullMqEmailsEnabled(env) ? "queued" : "direct",
      queued: false,
      success: false,
      reason: isBullMqEmailsEnabled(env) ? "enqueue_failed" : "delivery_failed",
    };
  }
}
