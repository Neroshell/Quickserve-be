import { createQueue } from "./createQueue.js";
import { EMAIL_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js";

const RESERVATION_JOB_NAMES = new Set([
  EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER,
  EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST,
  EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED,
  EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED,
  EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER,
]);

const BILLING_EMAIL_JOB_NAMES = new Set([
  EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE,
  EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
  EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3,
  EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5,
  EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED,
  EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED,
]);

const EMAIL_JOB_OPTIONS = Object.freeze({
  [EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER]: { attempts: 5 },
  [EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST]: { attempts: 5 },
  [EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED]: { attempts: 5 },
  [EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED]: { attempts: 5 },
  [EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER]: { attempts: 5 },
  [EMAIL_JOB_NAMES.ORDER_RECEIPT]: { attempts: 6 },
  [EMAIL_JOB_NAMES.REFUND_CONFIRMATION]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED]: { attempts: 8 },
  [EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED]: { attempts: 8 },
});

function requiredId(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200) {
    throw new TypeError(`${field} is required`);
  }
  return normalized;
}

export function sanitizeEmailJobIdComponent(value) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  if (!sanitized) throw new TypeError("A safe email job ID component is required");
  return sanitized;
}

export function validateEmailJobPayload(jobName, payload) {
  if (!EMAIL_JOB_OPTIONS[jobName]) {
    throw new TypeError("Unsupported email job name");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Email job payload must be an object");
  }

  const businessId = requiredId(payload.businessId, "businessId");
  if (RESERVATION_JOB_NAMES.has(jobName)) {
    return {
      businessId,
      reservationId: requiredId(payload.reservationId, "reservationId"),
      deliveryId: requiredId(payload.deliveryId, "deliveryId"),
      deliveryVersion: requiredId(payload.deliveryVersion, "deliveryVersion"),
    };
  }
  if (jobName === EMAIL_JOB_NAMES.ORDER_RECEIPT) {
    return {
      businessId,
      orderId: requiredId(payload.orderId, "orderId"),
    };
  }
  if (BILLING_EMAIL_JOB_NAMES.has(jobName)) {
    return {
      businessId,
      deliveryId: requiredId(payload.deliveryId, "deliveryId"),
      entityId: requiredId(payload.entityId, "entityId"),
      deliveryVersion: requiredId(payload.deliveryVersion, "deliveryVersion"),
    };
  }
  return {
    businessId,
    refundId: requiredId(payload.refundId, "refundId"),
  };
}

export function buildEmailJobId(jobName, payload) {
  const data = validateEmailJobPayload(jobName, payload);
  const businessId = sanitizeEmailJobIdComponent(data.businessId);

  switch (jobName) {
    case EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER:
      return `email-reservation-owner-${sanitizeEmailJobIdComponent(data.reservationId)}`;
    case EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST:
      return `email-reservation-guest-${sanitizeEmailJobIdComponent(data.reservationId)}`;
    case EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED:
      return `email-reservation-confirmed-${sanitizeEmailJobIdComponent(data.reservationId)}-${sanitizeEmailJobIdComponent(data.deliveryVersion)}`;
    case EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED:
      return `email-reservation-cancelled-${sanitizeEmailJobIdComponent(data.reservationId)}-${sanitizeEmailJobIdComponent(data.deliveryVersion)}`;
    case EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER:
      return `email-reservation-arrival-${businessId}-${sanitizeEmailJobIdComponent(data.reservationId)}-${sanitizeEmailJobIdComponent(data.deliveryVersion)}`;
    case EMAIL_JOB_NAMES.ORDER_RECEIPT:
      return `email-order-receipt-${businessId}-${sanitizeEmailJobIdComponent(data.orderId)}`;
    case EMAIL_JOB_NAMES.REFUND_CONFIRMATION:
      return `email-refund-${businessId}-${sanitizeEmailJobIdComponent(data.refundId)}`;
    case EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE:
    case EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS:
    case EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3:
    case EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5:
    case EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED:
    case EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED:
      return `email-billing-${businessId}-${sanitizeEmailJobIdComponent(jobName)}-${sanitizeEmailJobIdComponent(data.entityId)}-${sanitizeEmailJobIdComponent(data.deliveryVersion)}`;
    default:
      throw new TypeError("Unsupported email job name");
  }
}

export function getEmailJobEntityId(jobName, payload) {
  const data = validateEmailJobPayload(jobName, payload);
  return data.reservationId || data.orderId || data.refundId || data.entityId;
}

export async function enqueueEmailJob(
  jobName,
  payload,
  { env = process.env, queue, recover = false, delay = 0 } = {},
) {
  const data = validateEmailJobPayload(jobName, payload);
  const emailQueue = queue || createQueue(QUEUE_NAMES.EMAIL, { env });
  const jobId = buildEmailJobId(jobName, data);
  let recovered = false;

  if (recover && typeof emailQueue.getJob === "function") {
    const existing = await emailQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "failed" || state === "completed") {
        // Recreate an exhausted/finished job with the same stable ID so its
        // configured attempt budget starts fresh during explicit recovery.
        await existing.remove();
        recovered = true;
      } else {
        return { jobId, recovered: false };
      }
    }
  }

  const job = await emailQueue.add(jobName, data, {
    jobId,
    attempts: EMAIL_JOB_OPTIONS[jobName].attempts,
    delay: Math.max(0, Number(delay) || 0),
    backoff: {
      type: "exponential",
      delay: 30_000,
    },
  });
  return { jobId: job.id, recovered };
}

export { BILLING_EMAIL_JOB_NAMES, EMAIL_JOB_OPTIONS, RESERVATION_JOB_NAMES };
