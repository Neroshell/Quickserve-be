import crypto from "node:crypto"
import Order from "../models/order.js"
import { deriveOrderStatusFromLines, materializeLegacyOrderFulfillment } from "./orderFulfillmentService.js"
import {
  appendReconciliationHistory,
  createReconciliationHistoryEntry,
  reconciliationActorSnapshot,
  reconciliationStateSnapshot,
} from "./orderReconciliationAudit.js"
import { withCanonicalTransaction } from "../utils/transactionExecution.js"

// The route performs the authoritative, current-staff `orders.reconcile`
// permission check. This service keeps a narrow role boundary as defence in
// depth, while allowing an explicitly authorised waiter to correct a genuine
// missed handoff as approved for the reconciliation portal.
const RECONCILIATION_CORRECTION_ROLES = new Set(["owner", "co_owner", "manager", "waiter"])
const OPEN_HISTORICAL_STATUSES = new Set(["placed", "in_progress"])

export class HistoricalOrderCorrectionError extends Error {
  constructor(message, code = "HISTORICAL_ORDER_CORRECTION_ERROR", statusCode = 400) {
    super(message)
    this.name = "HistoricalOrderCorrectionError"
    this.code = code
    this.statusCode = statusCode
  }
}

function normalizeReason(value) {
  const reason = String(value || "").trim().replace(/\s+/g, " ")
  if (!reason) return null
  if (reason.length > 1000) {
    throw new HistoricalOrderCorrectionError(
      "The correction reason is too long",
      "HISTORICAL_CORRECTION_REASON_TOO_LONG",
      400,
    )
  }
  return reason
}

function originalPreparationEvidence(order) {
  const items = Array.isArray(order.items) ? order.items : []
  const readyLines = items.filter((item) => item.fulfillmentStatus === "ready").length
  const inProgressLines = items.filter((item) => item.fulfillmentStatus === "in_progress").length
  return {
    totalLines: items.length,
    readyLines,
    inProgressLines,
    pendingLines: Math.max(0, items.length - readyLines - inProgressLines),
  }
}

/**
 * Applies an authorized administrative completion only when normal completion
 * is unavailable. It moves the canonical current state to completed but never
 * invents line-level preparation, served, or inventory history.
 */
export async function confirmHistoricalServiceCorrection({ businessId, orderId, actor, reason }, dependencies = {}) {
  const OrderModel = dependencies.OrderModel || Order
  const runTransaction = dependencies.runTransaction || ((work) => withCanonicalTransaction(work, dependencies))
  const nowFactory = dependencies.now || (() => new Date())
  const performedBy = reconciliationActorSnapshot(actor)

  if (!RECONCILIATION_CORRECTION_ROLES.has(performedBy.role)) {
    throw new HistoricalOrderCorrectionError(
      "Only authorised reconciliation staff can reconcile an order without recorded preparation",
      "HISTORICAL_CORRECTION_ROLE_FORBIDDEN",
      403,
    )
  }

  const normalizedReason = normalizeReason(reason)

  return runTransaction(async (session) => {
    const order = await OrderModel.findOne({ businessId, orderId }, null, { session })
    if (!order) throw new HistoricalOrderCorrectionError("Order not found", "ORDER_NOT_FOUND", 404)

    if (order.historicalServiceCorrection?.confirmedAt) {
      return { order, changed: false, replayed: true }
    }
    if (order.status === "cancelled") {
      throw new HistoricalOrderCorrectionError("Cancelled orders cannot be corrected as served", "ORDER_CANCELLED", 409)
    }
    if (order.status === "completed") {
      throw new HistoricalOrderCorrectionError("This order is already completed", "HISTORICAL_CORRECTION_NOT_REQUIRED", 409)
    }
    if (order.status === "ready") {
      throw new HistoricalOrderCorrectionError(
        "This order has recorded preparation and must use the normal completion process",
        "HISTORICAL_CORRECTION_NORMAL_COMPLETION_REQUIRED",
        409,
      )
    }
    if (!OPEN_HISTORICAL_STATUSES.has(order.status)) {
      throw new HistoricalOrderCorrectionError("This order is not eligible for administrative completion", "HISTORICAL_CORRECTION_NOT_ELIGIBLE", 409)
    }
    if (order.paymentStatus !== "paid") {
      throw new HistoricalOrderCorrectionError("Record or confirm payment before reconciling service", "HISTORICAL_CORRECTION_PAYMENT_REQUIRED", 409)
    }

    // A ready order already has the canonical evidence needed for ordinary
    // completion. Do not let an administrator bypass that routine path.
    const readinessCheck = {
      status: order.status,
      items: (order.items || []).map((item) => ({ ...item })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      readyAt: order.readyAt,
    }
    materializeLegacyOrderFulfillment(readinessCheck)
    if (deriveOrderStatusFromLines(readinessCheck.items) === "ready" || order.status === "ready") {
      throw new HistoricalOrderCorrectionError(
        "This order has recorded preparation and must use the normal completion process",
        "HISTORICAL_CORRECTION_NORMAL_COMPLETION_REQUIRED",
        409,
      )
    }

    const now = nowFactory()
    const before = reconciliationStateSnapshot(order)
    const inventoryDisposition = order.inventoryReservationId && !order.inventoryReleased
      ? "unchanged_with_existing_reservation"
      : "unchanged"
    const correctionId = `hsc_${crypto.randomUUID()}`
    order.historicalServiceCorrection = {
      correctionId,
      type: "served_without_recorded_preparation",
      reason: normalizedReason,
      independentlyVerified: true,
      confirmedAt: now,
      confirmedBy: performedBy,
      originalStatus: order.status,
      originalPreparationEvidence: originalPreparationEvidence(order),
      inventoryDisposition,
    }

    // This is the authoritative current-state transition. completedAt is the
    // time the correction was applied, not a claim about when the guest was
    // served. servedAt and the frozen line-level evidence remain untouched.
    order.status = "completed"
    order.completedAt = now

    appendReconciliationHistory(order, createReconciliationHistoryEntry({
      businessId,
      reconciliationId: correctionId,
      operation: "administrative_completion",
      actor: performedBy,
      reason: normalizedReason,
      servedDeclaration: true,
      before,
      after: reconciliationStateSnapshot(order),
      inventoryDisposition,
      recordedAt: now,
    }))
    await order.save({ session })
    return { order, changed: true, replayed: false }
  })
}
