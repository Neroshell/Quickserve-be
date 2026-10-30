import assert from "node:assert/strict"
import test from "node:test"
import CommissionAccrual from "../src/models/CommissionAccrual.js"
import CommissionInvoiceBatch from "../src/models/CommissionInvoiceBatch.js"
import CommissionAdjustment from "../src/models/CommissionAdjustment.js"
import { readOfflineCommissionBilling } from "../src/services/offlineCommissionBillingReadService.js"
import { getOfflineCommissionBilling, reportOfflineUsage } from "../src/controllers/billingController.js"
import { recordOfflineCommissionAccrual } from "../src/services/offlineCommissionAccrualService.js"
import Business from "../src/models/Business.js"
import Order from "../src/models/Order.js"

function query(rows) { return { sort() { return this }, skip() { return this }, limit() { return this }, lean: async () => rows } }

test("offline commission read is tenant and currency scoped and separates paid from held", async () => {
  const originals = [CommissionAccrual.find, CommissionAccrual.countDocuments, CommissionInvoiceBatch.find, CommissionAdjustment.find]
  const scopes = []
  CommissionAccrual.find = (scope) => { scopes.push(scope); return query([{ _id: "a", businessId: "biz-a", currency: "EUR", status: "pending", commissionAmountCents: 50, eligibleAmountCents: 1000, billingPeriod: "period", createdAt: new Date(), sourceType: "order", sourceId: "O-1" }]) }
  CommissionAccrual.countDocuments = async () => 1
  CommissionInvoiceBatch.find = (scope) => { scopes.push(scope); return query([{ _id: "b", businessId: "biz-a", currency: "EUR", status: "held", amountCents: 50 }]) }
  CommissionAdjustment.find = (scope) => { scopes.push(scope); return query([]) }
  try {
    const result = await readOfflineCommissionBilling({ businessId: "biz-a", currency: "eur", currentPeriod: "period" })
    assert.equal(result.accruedAmountCents, 50); assert.equal(result.paidAmountCents, 0); assert.equal(result.failedAmountCents, 0); assert.equal(result.heldAmountCents, 50)
    assert.ok(scopes.every((scope) => scope.businessId === "biz-a")); assert.ok(scopes.filter((scope) => scope.currency).every((scope) => scope.currency === "EUR"))
  } finally { [CommissionAccrual.find, CommissionAccrual.countDocuments, CommissionInvoiceBatch.find, CommissionAdjustment.find] = originals }
})

test("offline commission controller rejects requests without a tenant session", async () => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body } }
  await getOfflineCommissionBilling({ session: {}, query: {} }, res)
  assert.equal(res.statusCode, 401)
})

function responseRecorder() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body } }
}

test("legacy usage reporting keeps pre-cutover paid orders eligible", async () => {
  const originals = [Business.findOne, Order.find]
  let orderScope
  Business.findOne = () => ({ lean: async () => ({ businessId: "biz-a", stripeMeteredSubscriptionItemId: "si_legacy", offlineCommissionInvoiceEnabled: false, offlineCommissionInvoiceCutoverAt: null }) })
  Order.find = (scope) => { orderScope = scope; return { lean: async () => [] } }
  try {
    const res = responseRecorder()
    await reportOfflineUsage({ session: { user: { businessId: "biz-a" } } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(orderScope.businessId, "biz-a")
    assert.equal(orderScope.paidAt, undefined)
  } finally { [Business.findOne, Order.find] = originals }
})

test("legacy usage reporting excludes post-cutover and timestamp-ambiguous orders", async () => {
  const originals = [Business.findOne, Order.find]
  let orderScope
  const cutover = new Date("2026-10-01T00:00:00.000Z")
  Business.findOne = () => ({ lean: async () => ({ businessId: "biz-a", stripeMeteredSubscriptionItemId: "si_legacy", offlineCommissionInvoiceEnabled: true, offlineCommissionInvoiceCutoverAt: cutover }) })
  Order.find = (scope) => { orderScope = scope; return { lean: async () => [] } }
  try {
    const res = responseRecorder()
    await reportOfflineUsage({ session: { user: { businessId: "biz-a" } } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(orderScope.paidAt, { $lt: cutover })
    assert.equal(orderScope.businessId, "biz-a")
  } finally { [Business.findOne, Order.find] = originals }
})

test("new accruals reject legacy-reported payments and use one stable source-payment identity", async () => {
  const original = CommissionAccrual.findOneAndUpdate
  const calls = []
  CommissionAccrual.findOneAndUpdate = async (filter, update, options) => {
    calls.push({ filter, update, options })
    return { _id: "accrual-1" }
  }
  const business = { businessId: "biz-a", currency: "EUR", offlineCommissionInvoiceEnabled: true, offlineCommissionInvoiceCutoverAt: new Date("2026-10-01T00:00:00.000Z") }
  const source = { _id: "order-1", paymentChannel: "offline", paymentStatus: "paid", paidAt: new Date("2026-10-02T00:00:00.000Z"), currency: "EUR", commissionRateApplied: 5, commissionAmountCents: 50 }
  try {
    const first = await recordOfflineCommissionAccrual({ business, sourceType: "order", source, eligibleAmountCents: 1000 })
    const second = await recordOfflineCommissionAccrual({ business, sourceType: "order", source, eligibleAmountCents: 1000 })
    const legacy = await recordOfflineCommissionAccrual({ business, sourceType: "order", source: { ...source, commissionReportedToStripe: true }, eligibleAmountCents: 1000 })
    assert.equal(first.recorded, true)
    assert.equal(second.recorded, true)
    assert.equal(legacy.reason, "legacy_metered_commission")
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].filter, calls[1].filter)
    assert.equal(calls[0].options.upsert, true)
  } finally { CommissionAccrual.findOneAndUpdate = original }
})
