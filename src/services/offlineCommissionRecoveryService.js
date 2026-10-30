import Business from "../models/Business.js"
import Order from "../models/order.js"
import Reservation from "../models/Reservation.js"
import { recoverMissingOfflineCommissionAccruals } from "./offlineCommissionAccrualService.js"
import { claimCommissionInvoiceBatch } from "./offlineCommissionInvoiceService.js"
import { createStripeCommissionInvoice } from "./offlineCommissionInvoiceService.js"
import Stripe from "stripe"

export async function recoverOfflineCommissionAccruals({ now = new Date(), businessModel = Business, orderModel = Order, reservationModel = Reservation } = {}) {
  const businesses = await businessModel.find({ offlineCommissionInvoiceEnabled: true, offlineCommissionInvoiceCutoverAt: { $ne: null } }).lean()
  let recovered = 0
  for (const business of businesses) {
    const base = { businessId: business.businessId, paymentChannel: "offline", paymentStatus: "paid", paidAt: { $gte: business.offlineCommissionInvoiceCutoverAt } }
    const [orders, reservations] = await Promise.all([
      orderModel.find({ ...base, status: { $ne: "cancelled" }, commissionReportedToStripe: { $ne: true } }).lean(),
      reservationModel.find({ ...base, status: { $nin: ["cancelled", "expired"] } }).lean(),
    ])
    const rows = await recoverMissingOfflineCommissionAccruals({ business, orders, reservations })
    recovered += rows.length
  }
  return { recovered, scannedAt: now }
}

export async function prepareCompletedCommissionBatches({ now = new Date(), env = process.env, businessModel = Business, stripeClient = null } = {}) {
  // Batches are only prepared for periods that ended before this scan; actual
  // Stripe collection remains behind the separate global feature gate.
  const Accrual = (await import("../models/CommissionAccrual.js")).default
  const rows = await Accrual.aggregate([
    { $match: { status: "pending" } },
    { $group: { _id: { businessId: "$businessId", billingPeriod: "$billingPeriod", currency: "$currency" } } },
  ])
  const prepared = []
  for (const row of rows) {
    const { businessId, billingPeriod, currency } = row._id
    if (billingPeriod.includes("/") && new Date(billingPeriod.split("/")[1]) > now) continue
    const result = await claimCommissionInvoiceBatch({ businessId, billingPeriod, currency })
    const batch = result.batch
    if (result.claimed) prepared.push(batch)
    // Collection is separate from batch preparation. This branch remains a
    // no-op in ordinary environments, even when automation is enabled.
    if (batch && env.CHILLOW_OFFLINE_COMMISSION_COLLECTION_ENABLED === "true") {
      const business = await businessModel.findOne({ businessId }).lean()
      const client = stripeClient || new Stripe(env.STRIPE_SECRET_KEY)
      await createStripeCommissionInvoice({ batchId: batch._id, business, stripeClient: client, env })
    }
  }
  return { prepared }
}
