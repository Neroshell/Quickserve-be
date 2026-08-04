import crypto from "node:crypto";
import Order from "../../models/order.js";
import {
  EmailDeliveryError,
  getOrderReceiptIdempotencyKey,
  sendReceiptEmail,
} from "../../utils/emailService.js";

const CLAIM_TTL_MS = 5 * 60 * 1000;

function safeErrorCode(error) {
  return String(error?.code || error?.name || "receipt_delivery_failed")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 200);
}

export async function ensureOrderReceiptIntent({
  businessId,
  orderId,
  orderModel = Order,
}) {
  const eligible = {
    businessId,
    orderId,
    paymentStatus: "paid",
    receiptSent: { $ne: true },
    receiptEmail: { $nin: [null, ""] },
    $or: [
      { receiptDeliveryStatus: { $exists: false } },
      { receiptDeliveryStatus: null },
      { receiptDeliveryStatus: "pending" },
      {
        receiptDeliveryStatus: "failed",
        receiptDeliveryRetryable: { $ne: false },
      },
    ],
  };
  const intent = await orderModel.findOneAndUpdate(
    eligible,
    {
      $set: {
        receiptDeliveryStatus: "pending",
        receiptDeliveryLastError: null,
        receiptDeliveryRetryable: true,
      },
    },
    { new: true },
  );
  if (intent) return intent;
  return orderModel.findOne({ businessId, orderId });
}

export async function markOrderReceiptEnqueued({
  businessId,
  orderId,
  orderModel = Order,
  now = new Date(),
}) {
  await orderModel.updateOne(
    {
      businessId,
      orderId,
      receiptSent: { $ne: true },
      receiptDeliveryStatus: { $ne: "sent" },
    },
    {
      $set: {
        receiptDeliveryEnqueuedAt: now,
        receiptDeliveryEnqueueError: null,
      },
    },
  );
}

export async function markOrderReceiptEnqueueFailed({
  businessId,
  orderId,
  error,
  orderModel = Order,
}) {
  const errorCode = safeErrorCode(error);
  await orderModel.updateOne(
    {
      businessId,
      orderId,
      receiptSent: { $ne: true },
    },
    {
      $set: {
        receiptDeliveryStatus: "pending",
        receiptDeliveryEnqueueError: errorCode,
        receiptDeliveryLastError: errorCode,
        receiptDeliveryRetryable: true,
      },
    },
  );
}

export async function claimOrderReceiptDelivery({
  businessId,
  orderId,
  orderModel = Order,
  now = new Date(),
  claimId = crypto.randomUUID(),
}) {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  return orderModel.findOneAndUpdate(
    {
      businessId,
      orderId,
      paymentStatus: "paid",
      receiptSent: { $ne: true },
      $or: [
        {
          receiptDeliveryStatus: { $in: ["pending", "failed"] },
          receiptDeliveryRetryable: { $ne: false },
        },
        {
          receiptDeliveryStatus: "processing",
          receiptDeliveryClaimedAt: { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        receiptDeliveryStatus: "processing",
        receiptDeliveryClaimedAt: now,
        receiptDeliveryClaimId: claimId,
        receiptDeliveryLastError: null,
      },
      $inc: { receiptDeliveryAttemptCount: 1 },
    },
    { new: true },
  );
}

export async function completeOrderReceiptDelivery({
  businessId,
  orderId,
  claimId,
  providerMessageId,
  orderModel = Order,
  now = new Date(),
}) {
  return orderModel.findOneAndUpdate(
    {
      businessId,
      orderId,
      receiptDeliveryStatus: "processing",
      receiptDeliveryClaimId: claimId,
    },
    {
      $set: {
        receiptSent: true,
        receiptSentAt: now,
        receiptDeliveryStatus: "sent",
        receiptDeliveryClaimedAt: null,
        receiptDeliveryClaimId: null,
        receiptDeliveryLastError: null,
        receiptDeliveryRetryable: false,
        receiptProviderMessageId: providerMessageId || null,
      },
    },
    { new: true },
  );
}

export async function failOrderReceiptDelivery({
  businessId,
  orderId,
  claimId,
  error,
  orderModel = Order,
}) {
  await orderModel.updateOne(
    {
      businessId,
      orderId,
      receiptDeliveryStatus: "processing",
      receiptDeliveryClaimId: claimId,
    },
    {
      $set: {
        receiptDeliveryStatus: "failed",
        receiptDeliveryClaimedAt: null,
        receiptDeliveryClaimId: null,
        receiptDeliveryLastError: safeErrorCode(error),
        receiptDeliveryRetryable: error?.retryable !== false,
      },
    },
  );
}

export async function processOrderReceiptDelivery(
  job,
  {
    orderModel = Order,
    sendReceipt = sendReceiptEmail,
    now = new Date(),
  } = {},
) {
  const { businessId, orderId } = job.data;
  const claim = await claimOrderReceiptDelivery({
    businessId,
    orderId,
    orderModel,
    now,
  });
  if (!claim) return { skipped: true, reason: "not_claimed" };

  try {
    if (!claim.receiptEmail) {
      throw new EmailDeliveryError("Receipt recipient is missing.", {
        code: "recipient_missing",
        retryable: false,
      });
    }
    const result = await sendReceipt(claim, claim.receiptEmail, {
      idempotencyKey: getOrderReceiptIdempotencyKey(claim),
      returnResult: true,
    });
    if (!result || result.success !== true) {
      throw new EmailDeliveryError("Provider did not accept the receipt.", {
        code: "provider_not_accepted",
        retryable: true,
      });
    }

    await completeOrderReceiptDelivery({
      businessId,
      orderId,
      claimId: claim.receiptDeliveryClaimId,
      providerMessageId: result.messageId,
      orderModel,
      now,
    });
    return { success: true, messageId: result.messageId || null };
  } catch (error) {
    await failOrderReceiptDelivery({
      businessId,
      orderId,
      claimId: claim.receiptDeliveryClaimId,
      error,
      orderModel,
    });
    throw error;
  }
}

export { safeErrorCode as safeOrderReceiptErrorCode };
