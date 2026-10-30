import CommissionAccrual from "../models/CommissionAccrual.js"
import CommissionInvoiceBatch from "../models/CommissionInvoiceBatch.js"
import CommissionAdjustment from "../models/CommissionAdjustment.js"

function sum(rows, field) { return rows.reduce((total, row) => total + Number(row[field] || 0), 0) }

export async function readOfflineCommissionBilling({ businessId, currency, currentPeriod = null, page = 1, limit = 50 }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100))
  const safePage = Math.max(1, Number(page) || 1)
  const scope = { businessId, ...(currency ? { currency: String(currency).toUpperCase() } : {}) }
  const [allAccruals, accruals, batches, adjustments, totalActivities] = await Promise.all([
    CommissionAccrual.find(scope).lean(),
    CommissionAccrual.find(scope).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    CommissionInvoiceBatch.find(scope).sort({ createdAt: -1 }).lean(),
    CommissionAdjustment.find({ businessId }).sort({ createdAt: -1 }).lean(),
    CommissionAccrual.countDocuments(scope),
  ])
  const byStatus = (status) => allAccruals.filter((row) => row.status === status)
  const pending = byStatus("pending")
  const invoiced = byStatus("invoiced")
  const failedBatchIds = new Set(batches.filter((batch) => batch.status === "failed").map((batch) => String(batch._id)))
  const activities = accruals.map((row) => ({
    id: String(row._id), sourceType: row.sourceType, sourceId: row.sourceId,
    confirmedAt: row.createdAt, eligibleAmountCents: row.eligibleAmountCents,
    commissionRateApplied: row.commissionRateApplied, commissionAmountCents: row.commissionAmountCents,
    currency: row.currency, billingPeriod: row.billingPeriod, status: row.status,
    invoiceBatchId: row.invoiceBatchId ? String(row.invoiceBatchId) : null,
    stripeInvoiceId: row.stripeInvoiceId || null,
  }))
  return {
    currentPeriod: currentPeriod || null,
    currentPeriodAccruedAmountCents: currentPeriod ? sum(pending.filter((row) => row.billingPeriod === currentPeriod), "commissionAmountCents") : null,
    accruedAmountCents: sum(pending, "commissionAmountCents"),
    invoicedAmountCents: sum(invoiced, "commissionAmountCents"),
    paidAmountCents: sum(batches.filter((batch) => batch.status === "paid"), "amountCents"),
    failedAmountCents: sum(batches.filter((batch) => batch.status === "failed"), "amountCents"),
    heldAmountCents: sum(batches.filter((batch) => batch.status === "held"), "amountCents"),
    adjustmentAmountCents: sum(adjustments, "amountCents"),
    collectionState: "disabled",
    pagination: { page: safePage, limit: safeLimit, total: totalActivities },
    activities,
    batches: batches.map((batch) => ({ id: String(batch._id), billingPeriod: batch.billingPeriod, currency: batch.currency, status: batch.status, amountCents: batch.amountCents, stripeInvoiceId: batch.stripeInvoiceId || null, failed: failedBatchIds.has(String(batch._id)) })),
    adjustments: adjustments.map((row) => ({ id: String(row._id), amountCents: row.amountCents, status: row.status, stripeCreditNoteId: row.stripeCreditNoteId || null, createdAt: row.createdAt })),
  }
}
