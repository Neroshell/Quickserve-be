import crypto from "node:crypto"

function countFulfillmentEvidence(items = []) {
  const lines = Array.isArray(items) ? items : []
  const readyLines = lines.filter((item) => item.fulfillmentStatus === "ready").length
  const inProgressLines = lines.filter((item) => item.fulfillmentStatus === "in_progress").length
  return {
    totalLines: lines.length,
    readyLines,
    inProgressLines,
    pendingLines: Math.max(0, lines.length - readyLines - inProgressLines),
  }
}

export function reconciliationActorSnapshot(actor = {}) {
  return {
    staffId: String(actor.staffId || actor.id || "").trim() || null,
    name: String(actor.name || "").trim() || null,
    role: String(actor.role || "").trim() || null,
  }
}

export function reconciliationStateSnapshot(order = {}) {
  return {
    status: order.status || null,
    paymentStatus: order.paymentStatus || null,
    paidVia: order.paidVia || null,
    preparationEvidence: countFulfillmentEvidence(order.items),
  }
}

/**
 * A bounded, append-only record of state changes made through the recovery
 * workflow. It records what the system knew at the time; it never invents
 * missing preparation events or rewrites source history.
 */
export function createReconciliationHistoryEntry({
  businessId,
  operation,
  actor,
  before,
  after,
  reason = null,
  servedDeclaration = null,
  inventoryDisposition = "not_applicable",
  recordedAt = new Date(),
  reconciliationId = `recon_${crypto.randomUUID()}`,
}) {
  return {
    reconciliationId,
    operation,
    businessId,
    recordedAt,
    performedBy: reconciliationActorSnapshot(actor),
    reason: reason || null,
    servedDeclaration,
    before,
    after,
    inventoryDisposition,
  }
}

export function appendReconciliationHistory(order, entry) {
  const history = Array.isArray(order.reconciliationHistory) ? order.reconciliationHistory : []
  order.reconciliationHistory = [...history, entry].slice(-20)
  return entry
}

