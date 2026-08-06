import EmailDelivery from "../../models/EmailDelivery.js";
import Order from "../../models/order.js";
import ReservationRefund from "../../models/ReservationRefund.js";
import { enqueueEmailJob, EMAIL_JOB_NAMES } from "../../queues/index.js";
import {
  markOrderReceiptEnqueued,
  markOrderReceiptEnqueueFailed,
} from "./orderReceiptDeliveryService.js";
import {
  markRefundEmailEnqueued,
  markRefundEmailEnqueueFailed,
} from "./refundEmailDeliveryService.js";
import {
  markReservationEmailEnqueued,
  markReservationEmailEnqueueFailed,
} from "./reservationEmailDeliveryService.js";

const CLAIM_TTL_MS = 5 * 60 * 1000;

async function queryRows(query, limit) {
  const limited = typeof query?.limit === "function" ? query.limit(limit) : query;
  return typeof limited?.lean === "function" ? limited.lean() : limited;
}

export async function recoverEmailDeliveries({
  businessId,
  limit = 100,
  now = new Date(),
  deliveryModel = EmailDelivery,
  orderModel = Order,
  refundModel = ReservationRefund,
  enqueue = enqueueEmailJob,
}) {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const [reservationDeliveries, orders, refunds] = await Promise.all([
    queryRows(deliveryModel.find({
      businessId,
      retryable: { $ne: false },
      sentAt: null,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "processing", claimedAt: { $lt: staleBefore } },
      ],
    }), limit),
    queryRows(orderModel.find({
      businessId,
      paymentStatus: "paid",
      receiptSent: { $ne: true },
      receiptDeliveryRetryable: { $ne: false },
      $or: [
        { receiptDeliveryStatus: { $in: ["pending", "failed"] } },
        {
          receiptDeliveryStatus: "processing",
          receiptDeliveryClaimedAt: { $lt: staleBefore },
        },
      ],
    }), limit),
    queryRows(refundModel.find({
      businessId,
      status: "succeeded",
      customerEmailSentAt: null,
      customerEmailRetryable: { $ne: false },
      $or: [
        { customerEmailStatus: { $in: ["pending", "failed"] } },
        {
          customerEmailStatus: "processing",
          customerEmailSendingAt: { $lt: staleBefore },
        },
      ],
    }), limit),
  ]);

  const summary = {
    attempted: 0,
    requeued: 0,
    failed: 0,
    reservation: 0,
    orderReceipt: 0,
    refund: 0,
  };

  for (const delivery of reservationDeliveries) {
    summary.attempted += 1;
    try {
      await enqueue(delivery.jobName, {
        businessId,
        reservationId: delivery.entityId,
        deliveryId: delivery.deliveryId,
        deliveryVersion: delivery.deliveryVersion,
      }, {
        recover: true,
        delay: delivery.scheduledFor
          ? Math.max(0, new Date(delivery.scheduledFor).getTime() - now.getTime())
          : 0,
      });
      await markReservationEmailEnqueued({
        deliveryId: delivery.deliveryId,
        businessId,
        deliveryModel,
        now,
      });
      summary.requeued += 1;
      summary.reservation += 1;
    } catch (error) {
      await markReservationEmailEnqueueFailed({
        deliveryId: delivery.deliveryId,
        businessId,
        error,
        deliveryModel,
      });
      summary.failed += 1;
    }
  }

  for (const order of orders) {
    summary.attempted += 1;
    try {
      await enqueue(EMAIL_JOB_NAMES.ORDER_RECEIPT, {
        businessId,
        orderId: order.orderId,
      }, { recover: true });
      await markOrderReceiptEnqueued({
        businessId,
        orderId: order.orderId,
        orderModel,
        now,
      });
      summary.requeued += 1;
      summary.orderReceipt += 1;
    } catch (error) {
      await markOrderReceiptEnqueueFailed({
        businessId,
        orderId: order.orderId,
        error,
        orderModel,
      });
      summary.failed += 1;
    }
  }

  for (const refund of refunds) {
    summary.attempted += 1;
    try {
      await enqueue(EMAIL_JOB_NAMES.REFUND_CONFIRMATION, {
        businessId,
        refundId: refund.refundId,
      }, { recover: true });
      await markRefundEmailEnqueued({
        businessId,
        refundId: refund.refundId,
        refundModel,
        now,
      });
      summary.requeued += 1;
      summary.refund += 1;
    } catch (error) {
      await markRefundEmailEnqueueFailed({
        businessId,
        refundId: refund.refundId,
        error,
        refundModel,
      });
      summary.failed += 1;
    }
  }

  return summary;
}
