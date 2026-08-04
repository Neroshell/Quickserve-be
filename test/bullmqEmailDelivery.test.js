import test from "node:test";
import assert from "node:assert/strict";
import { UnrecoverableError } from "bullmq";
import {
  EMAIL_JOB_OPTIONS,
  enqueueEmailJob,
  validateEmailJobPayload,
} from "../src/queues/emailQueue.js";
import { EMAIL_JOB_NAMES } from "../src/queues/queueNames.js";
import {
  dispatchRestaurantReservationEmail,
} from "../src/services/email/emailDispatchService.js";
import {
  claimReservationEmailDelivery,
} from "../src/services/email/reservationEmailDeliveryService.js";
import {
  processOrderReceiptDelivery,
} from "../src/services/email/orderReceiptDeliveryService.js";
import {
  processRefundEmailDelivery,
} from "../src/services/email/refundEmailDeliveryService.js";
import { processEmailJob } from "../src/workers/processors/emailProcessor.js";
import {
  EmailDeliveryError,
  sendEmailWithResult,
} from "../src/utils/emailService.js";

function comparable(value) {
  return value instanceof Date ? value.getTime() : String(value);
}

function matches(document, filter) {
  if (!document) return false;
  for (const [key, condition] of Object.entries(filter || {})) {
    if (key === "$or") {
      if (!condition.some((branch) => matches(document, branch))) return false;
      continue;
    }
    const actual = document[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("$ne" in condition && comparable(actual) === comparable(condition.$ne)) return false;
      if ("$in" in condition && !condition.$in.some((value) => comparable(value) === comparable(actual))) return false;
      if ("$nin" in condition && condition.$nin.some((value) => comparable(value) === comparable(actual))) return false;
      if ("$exists" in condition && (actual !== undefined) !== condition.$exists) return false;
      if ("$lt" in condition && !(actual && new Date(actual) < new Date(condition.$lt))) return false;
      continue;
    }
    if (condition === null) {
      if (actual !== null && actual !== undefined) return false;
    } else if (comparable(actual) !== comparable(condition)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(document, update) {
  if (update?.$set) Object.assign(document, update.$set);
  if (update?.$inc) {
    for (const [field, amount] of Object.entries(update.$inc)) {
      document[field] = Number(document[field] || 0) + Number(amount);
    }
  }
  return document;
}

function atomicModel(document) {
  return {
    document,
    async findOne(filter) {
      return matches(document, filter) ? document : null;
    },
    async findOneAndUpdate(filter, update) {
      if (!matches(document, filter)) return null;
      applyUpdate(document, update);
      return document;
    },
    async updateOne(filter, update) {
      if (!matches(document, filter)) return { matchedCount: 0 };
      applyUpdate(document, update);
      return { matchedCount: 1 };
    },
  };
}

function orderDeliveryStore(overrides = {}) {
  return atomicModel({
    _id: "mongo-order-1",
    businessId: "business-1",
    orderId: "ORDER-1",
    paymentStatus: "paid",
    receiptEmail: "guest@example.com",
    receiptSent: false,
    receiptSentAt: null,
    receiptDeliveryStatus: "pending",
    receiptDeliveryAttemptCount: 0,
    receiptDeliveryRetryable: true,
    receiptDeliveryClaimedAt: null,
    receiptDeliveryClaimId: null,
    items: [{ itemName: "Meal", quantity: 1, lineTotal: 10 }],
    total: 10,
    createdAt: new Date("2026-08-02T12:00:00.000Z"),
    ...overrides,
  });
}

test("email queue uses stable IDs, strips extra payload fields, and applies per-job retries", async () => {
  const jobs = new Map();
  let physicalAdds = 0;
  const queue = {
    async add(name, data, options) {
      if (jobs.has(options.jobId)) return jobs.get(options.jobId);
      physicalAdds += 1;
      const job = { id: options.jobId, name, data, options };
      jobs.set(options.jobId, job);
      return job;
    },
  };
  const payload = {
    businessId: "business-1",
    orderId: "ORDER:1",
    email: "must-not-enter-redis@example.com",
  };

  const first = await enqueueEmailJob(
    EMAIL_JOB_NAMES.ORDER_RECEIPT,
    payload,
    { queue },
  );
  const second = await enqueueEmailJob(
    EMAIL_JOB_NAMES.ORDER_RECEIPT,
    payload,
    { queue },
  );

  assert.equal(first.jobId, second.jobId);
  assert.equal(first.jobId.includes(":"), false);
  assert.equal(physicalAdds, 1);
  assert.deepEqual(jobs.get(first.jobId).data, {
    businessId: "business-1",
    orderId: "ORDER:1",
  });
  assert.equal(jobs.get(first.jobId).options.attempts, 6);
  assert.equal(EMAIL_JOB_OPTIONS[EMAIL_JOB_NAMES.REFUND_CONFIRMATION].attempts, 8);
});

test("the centralized feature flag selects exactly one direct or queued path", async () => {
  let directCalls = 0;
  let enqueueCalls = 0;
  const base = {
    jobName: EMAIL_JOB_NAMES.RESERVATION_REQUEST_GUEST,
    businessId: "business-1",
    reservationId: "reservation-1",
    deliveryVersion: "1",
    directSend: async () => {
      directCalls += 1;
      return true;
    },
    dependencies: {
      markDirectSent: async () => {},
      ensureIntent: async () => ({
        deliveryId: "email-reservation-guest-reservation-1",
        deliveryVersion: "1",
        status: "pending",
        retryable: true,
      }),
      enqueue: async () => {
        enqueueCalls += 1;
        return { jobId: "email-reservation-guest-reservation-1" };
      },
      markEnqueued: async () => {},
      markFailed: async () => {},
    },
  };

  const direct = await dispatchRestaurantReservationEmail({
    ...base,
    env: { BULLMQ_EMAILS_ENABLED: "false" },
  });
  const queued = await dispatchRestaurantReservationEmail({
    ...base,
    env: { BULLMQ_EMAILS_ENABLED: "true" },
  });

  assert.equal(direct.mode, "direct");
  assert.equal(directCalls, 1);
  assert.equal(queued.mode, "queued");
  assert.equal(queued.queued, true);
  assert.equal(enqueueCalls, 1);
  assert.equal(directCalls, 1);
});

test("two workers cannot claim the same reservation delivery", async () => {
  const model = atomicModel({
    deliveryId: "delivery-1",
    businessId: "business-1",
    status: "pending",
    retryable: true,
    sentAt: null,
    claimedAt: null,
    attemptCount: 0,
  });
  const [first, second] = await Promise.all([
    claimReservationEmailDelivery({
      deliveryId: "delivery-1",
      businessId: "business-1",
      deliveryModel: model,
      claimId: "claim-1",
    }),
    claimReservationEmailDelivery({
      deliveryId: "delivery-1",
      businessId: "business-1",
      deliveryModel: model,
      claimId: "claim-2",
    }),
  ]);

  assert.equal(Boolean(first) + Boolean(second), 1);
  assert.equal(model.document.status, "processing");
  assert.equal(model.document.attemptCount, 1);
});

test("provider errors expose retryability while the boolean wrapper remains compatible", async () => {
  const transientClient = {
    emails: {
      async send() {
        return { data: null, error: { name: "application_error", statusCode: 503 } };
      },
    },
  };
  const permanentClient = {
    emails: {
      async send() {
        return { data: null, error: { name: "validation_error", statusCode: 422 } };
      },
    },
  };
  const options = {
    to: "guest@example.com",
    from: "QuickServe <test@example.com>",
    subject: "Test",
    html: "<p>Test</p>",
  };

  await assert.rejects(
    sendEmailWithResult({ ...options, emailClient: transientClient }),
    (error) => error instanceof EmailDeliveryError && error.retryable === true,
  );
  await assert.rejects(
    sendEmailWithResult({ ...options, emailClient: permanentClient }),
    (error) => error instanceof EmailDeliveryError && error.retryable === false,
  );
});

test("successful receipt delivery persists provider ID and an attempt count", async () => {
  const store = orderDeliveryStore();
  const result = await processOrderReceiptDelivery(
    {
      name: EMAIL_JOB_NAMES.ORDER_RECEIPT,
      data: { businessId: "business-1", orderId: "ORDER-1" },
    },
    {
      orderModel: store,
      sendReceipt: async () => ({ success: true, messageId: "msg-order-1" }),
      now: new Date("2026-08-02T13:00:00.000Z"),
    },
  );

  assert.equal(result.success, true);
  assert.equal(store.document.receiptSent, true);
  assert.equal(store.document.receiptDeliveryStatus, "sent");
  assert.equal(store.document.receiptDeliveryAttemptCount, 1);
  assert.equal(store.document.receiptProviderMessageId, "msg-order-1");
});

test("provider false marks a retryable failure and throws for BullMQ retry", async () => {
  const store = orderDeliveryStore();

  await assert.rejects(
    processOrderReceiptDelivery(
      {
        name: EMAIL_JOB_NAMES.ORDER_RECEIPT,
        data: { businessId: "business-1", orderId: "ORDER-1" },
      },
      { orderModel: store, sendReceipt: async () => false },
    ),
    (error) => error.retryable === true,
  );
  assert.equal(store.document.receiptDeliveryStatus, "failed");
  assert.equal(store.document.receiptDeliveryAttemptCount, 1);
  assert.equal(store.document.receiptDeliveryLastError, "provider_not_accepted");
  assert.equal(store.document.receiptDeliveryRetryable, true);
});

test("a permanent recipient failure becomes unrecoverable and is persisted", async () => {
  const store = orderDeliveryStore({ receiptEmail: null });

  await assert.rejects(
    processEmailJob(
      {
        name: EMAIL_JOB_NAMES.ORDER_RECEIPT,
        data: { businessId: "business-1", orderId: "ORDER-1" },
      },
      { order: { orderModel: store, sendReceipt: async () => true } },
    ),
    (error) => error instanceof UnrecoverableError,
  );
  assert.equal(store.document.receiptDeliveryStatus, "failed");
  assert.equal(store.document.receiptDeliveryRetryable, false);
  assert.equal(store.document.receiptDeliveryLastError, "recipient_missing");
});

test("successful refund email reuses its atomic claim and stores the provider ID", async () => {
  const refundModel = atomicModel({
    _id: "refund-document-1",
    refundId: "RF-1",
    businessId: "business-1",
    reservationId: "reservation-1",
    status: "succeeded",
    customerEmailStatus: "pending",
    customerEmailSentAt: null,
    customerEmailSendingAt: null,
    customerEmailRetryable: true,
    customerEmailAttemptCount: 0,
  });
  const reservationModel = {
    async findOne(filter) {
      assert.deepEqual(filter, {
        _id: "reservation-1",
        businessId: "business-1",
      });
      return { _id: "reservation-1", email: "guest@example.com" };
    },
  };
  const businessModel = {
    findOne(filter) {
      assert.deepEqual(filter, { businessId: "business-1" });
      return { lean: async () => ({ businessId: "business-1", name: "Hotel" }) };
    },
  };

  const result = await processRefundEmailDelivery(
    {
      name: EMAIL_JOB_NAMES.REFUND_CONFIRMATION,
      data: { businessId: "business-1", refundId: "RF-1" },
    },
    {
      refundModel,
      reservationModel,
      businessModel,
      sendRefundEmail: async () => ({ success: true, messageId: "msg-refund-1" }),
    },
  );

  assert.equal(result.success, true);
  assert.equal(refundModel.document.customerEmailStatus, "sent");
  assert.equal(refundModel.document.customerEmailAttemptCount, 1);
  assert.equal(refundModel.document.customerEmailProviderMessageId, "msg-refund-1");
});

test("one-time-secret and hotel check-in job names are rejected by the queue contract", () => {
  for (const forbiddenName of [
    "password-reset",
    "signup-code",
    "staff-invitation",
    "email-change-verification",
    "hotel-check-in-code",
    "reservation-payment-link",
  ]) {
    assert.throws(
      () => validateEmailJobPayload(forbiddenName, {}),
      /Unsupported email job name/,
    );
  }
});
