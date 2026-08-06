import { UnrecoverableError } from "bullmq";
import {
  EMAIL_JOB_NAMES,
  validateEmailJobPayload,
} from "../../queues/index.js";
import { processOrderReceiptDelivery } from "../../services/email/orderReceiptDeliveryService.js";
import { processRefundEmailDelivery } from "../../services/email/refundEmailDeliveryService.js";
import { processReservationEmailDelivery } from "../../services/email/reservationEmailDeliveryService.js";

const RESERVATION_JOBS = new Set([
  EMAIL_JOB_NAMES.RESERVATION_REQUEST_OWNER,
  EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST,
  EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CONFIRMED,
  EMAIL_JOB_NAMES.RESTAURANT_RESERVATION_CANCELLED,
  EMAIL_JOB_NAMES.RESERVATION_ARRIVAL_REMINDER,
]);

export async function processEmailJob(job, dependencies = {}) {
  validateEmailJobPayload(job?.name, job?.data);

  try {
    if (RESERVATION_JOBS.has(job.name)) {
      return await processReservationEmailDelivery(
        job,
        dependencies.reservation,
      );
    }
    if (job.name === EMAIL_JOB_NAMES.ORDER_RECEIPT) {
      return await processOrderReceiptDelivery(job, dependencies.order);
    }
    if (job.name === EMAIL_JOB_NAMES.REFUND_CONFIRMATION) {
      return await processRefundEmailDelivery(job, dependencies.refund);
    }
    throw new TypeError("Unsupported email job");
  } catch (error) {
    if (error?.retryable === false) {
      throw new UnrecoverableError(error.code || "permanent_email_failure");
    }
    throw error;
  }
}
