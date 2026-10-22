import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"
import {
  assessOrderReconciliation,
  waiterPastOrders,
} from "../src/controllers/waitstaffOrdersController.js"
import Business from "../src/models/Business.js"
import Order from "../src/models/order.js"
import Staff from "../src/models/Staff.js"
import ServicePoint from "../src/models/ServicePoint.js"

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

test("waiterPastOrders: successfully returns pagination and preserves search without trimmedSearch runtime error", async (t) => {
  const origFindOne = Business.findOne
  const origOrderFind = Order.find
  const origOrderCount = Order.countDocuments
  const origStaffFind = Staff.find
  const origServicePointFind = ServicePoint.find

  const testBizId = "biz_test_past_orders"

  Business.findOne = () => ({
    lean: async () => ({
      businessId: testBizId,
      timezone: "UTC",
    }),
  })

  let capturedFilter = null
  Order.find = (filter) => {
    capturedFilter = filter
    return {
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: async () => [
              {
                orderId: "QS-TEST-001",
                businessId: testBizId,
                servicePointId: "sp_test_table_7",
                status: "ready",
                paymentStatus: "paid",
                paymentChannel: "online",
                total: 25.5,
                currency: "USD",
                createdAt: new Date("2026-10-10T12:00:00Z"),
                items: [
                  { itemName: "Burger", quantity: 1, lineTotal: 25.5, fulfillmentStatus: "ready" },
                ],
              },
              {
                orderId: "QS-TEST-002",
                businessId: testBizId,
                servicePointId: "sp_missing_legacy",
                status: "placed",
                paymentStatus: "paid",
                paymentChannel: "online",
                total: 15.0,
                currency: "USD",
                createdAt: new Date("2026-10-10T11:00:00Z"),
                items: [
                  { itemName: "Salad", quantity: 1, lineTotal: 15.0 },
                ],
              },
              {
                orderId: "QS-TEST-003",
                businessId: testBizId,
                status: "ready",
                paymentStatus: "unpaid",
                paymentChannel: "offline",
                total: 30.0,
                currency: "USD",
                createdAt: new Date("2026-10-10T10:00:00Z"),
                items: [
                  { itemName: "Steak", quantity: 1, lineTotal: 30.0, fulfillmentStatus: "ready" },
                ],
              },
            ],
          }),
        }),
      }),
    }
  }

  Order.countDocuments = async () => 3

  Staff.find = () => ({
    lean: async () => [],
  })

  ServicePoint.find = (filter) => ({
    lean: async () => filter?.servicePointId?.$in?.includes("sp_test_table_7")
      ? [{ servicePointId: "sp_test_table_7", label: "Table 7" }]
      : [],
  })

  t.after(() => {
    Business.findOne = origFindOne
    Order.find = origOrderFind
    Order.countDocuments = origOrderCount
    Staff.find = origStaffFind
    ServicePoint.find = origServicePointFind
  })

  // 1. Test search with special regex characters and verify trimmedSearch is not thrown
  const req = {
    session: { user: { businessId: testBizId } },
    query: {
      search: "  [test]*?+  ",
      range: "yesterday",
    },
  }
  const res = createMockResponse()

  await waiterPastOrders(req, res)

  assert.equal(res.statusCode, 200)
  assert.ok(res.body)
  assert.equal(res.body.filters.search, "  [test]*?+  ")
  assert.equal(res.body.pagination.total, 3)
  assert.equal(res.body.pagination.page, 1)
  assert.equal(res.body.orders.length, 3)

  // Verify canonical eligibility derivation
  const [readyPaid, placedPaid, readyOfflineUnpaid] = res.body.orders
  assert.equal(readyPaid.canMarkCompleted, true)
  assert.equal(readyPaid.reconciliationStatus, "ready_to_complete")
  assert.equal(readyPaid.servicePoint, "Table 7")
  assert.equal(readyPaid.servicePointLabel, "Table 7")

  assert.equal(placedPaid.canMarkCompleted, false)
  assert.equal(placedPaid.reconciliationStatus, "prep_not_confirmed")
  assert.equal(placedPaid.reconciliationReason, "Kitchen or bar preparation has not been marked ready")
  assert.equal(placedPaid.servicePoint, "Service point unavailable")

  assert.equal(readyOfflineUnpaid.canMarkCompleted, false)
  assert.equal(readyOfflineUnpaid.canMarkPaid, true)
  assert.equal(readyOfflineUnpaid.reconciliationStatus, "payment_required")
  assert.equal(readyOfflineUnpaid.reconciliationReason, "Offline payment must be recorded before order can be completed")
})

test("waiterPastOrders: status=needs_reconciliation uses unbounded historical query matching dashboard criteria", async (t) => {
  const origFindOne = Business.findOne
  const origOrderFind = Order.find
  const origOrderCount = Order.countDocuments
  const origStaffFind = Staff.find

  const testBizId = "biz_test_reconcile"

  Business.findOne = () => ({
    lean: async () => ({
      businessId: testBizId,
      timezone: "UTC",
    }),
  })

  let capturedFilter = null
  Order.find = (filter) => {
    capturedFilter = filter
    return {
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: async () => [],
          }),
        }),
      }),
    }
  }

  Order.countDocuments = async () => 0

  Staff.find = () => ({
    lean: async () => [],
  })

  t.after(() => {
    Business.findOne = origFindOne
    Order.find = origOrderFind
    Order.countDocuments = origOrderCount
    Staff.find = origStaffFind
  })

  const req = {
    session: { user: { businessId: testBizId } },
    query: {
      status: "needs_reconciliation",
    },
  }
  const res = createMockResponse()

  await waiterPastOrders(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.filters.status, "needs_reconciliation")
  assert.equal(res.body.filters.range, "all")

  // Verify the filter query structure
  assert.ok(capturedFilter.$and)
  const clauses = capturedFilter.$and

  // Business ID clause
  const bizClause = clauses.find((c) => c.businessId === testBizId)
  assert.ok(bizClause)

  // Historical date clause: createdAt < todayStart (no lower bound)
  const dateClause = clauses.find((c) => c.createdAt && c.createdAt.$lt)
  assert.ok(dateClause)
  assert.equal(dateClause.createdAt.$gte, undefined) // no lower bound!

  // Reconciliation OR clause matching ownerController
  const reconClause = clauses.find((c) => c.$or && c.$or.some((item) => item.status && item.status.$in))
  assert.ok(reconClause)
  assert.deepEqual(reconClause.$or, [
    { status: { $in: ["placed", "in_progress", "ready"] } },
    { paymentChannel: "offline", paymentStatus: { $ne: "paid" }, status: { $ne: "cancelled" } },
  ])
})

test("reconcileComplete: idempotent replay and server-side readiness enforcement", async (t) => {
  const { reconcileComplete } = await import("../src/controllers/orderController.js")

  const origOrderFindOne = Order.findOne
  const origStartSession = mongoose.startSession
  const testBizId = "biz_test_reconcile_action"

  mongoose.startSession = async () => ({
    withTransaction: async (work) => work({ id: "mock_session" }),
    endSession: async () => {},
  })

  t.after(() => {
    Order.findOne = origOrderFindOne
    mongoose.startSession = origStartSession
  })

  // Case 1: Reconcile an already completed order -> returns idempotent replay
  const completedOrderMock = {
    orderId: "QS-DONE-123",
    businessId: testBizId,
    status: "completed",
    completedAt: new Date("2026-10-10T12:00:00Z"),
    items: [],
    save: async () => {},
  }

  Order.findOne = () => ({
    session: () => completedOrderMock,
    then(onFulfilled) { return Promise.resolve(completedOrderMock).then(onFulfilled) },
  })
  // If called as findOne({ businessId, orderId }, null, { session })
  Order.findOne = async () => completedOrderMock

  const req1 = {
    session: { user: { businessId: testBizId, role: "owner", name: "Boss" } },
    params: { orderId: "QS-DONE-123" },
  }
  const res1 = createMockResponse()

  await reconcileComplete(req1, res1)
  assert.equal(res1.statusCode, 200)
  assert.equal(res1.body.success, true)
  assert.equal(res1.body.replayed, true)

  // Case 2: Attempt to reconcile an unready order -> rejects with 409
  const unreadyOrderMock = {
    orderId: "QS-UNREADY-456",
    businessId: testBizId,
    status: "placed",
    paymentChannel: "online",
    paymentStatus: "paid",
    items: [{ itemName: "Pizza", quantity: 1, lineTotal: 20 }], // no ready status
    save: async () => {},
  }
  Order.findOne = async () => unreadyOrderMock

  const req2 = {
    session: { user: { businessId: testBizId, role: "owner", name: "Boss" } },
    params: { orderId: "QS-UNREADY-456" },
  }
  const res2 = createMockResponse()

  await reconcileComplete(req2, res2)
  assert.equal(res2.statusCode, 409)
  assert.equal(res2.body.code, "ORDER_NOT_READY_TO_SERVE")
})

test("reconciliation assessment distinguishes routine completion, payment resolution, and review", () => {
  const base = {
    paymentChannel: "online",
    paymentStatus: "paid",
    createdAt: new Date("2026-10-10T10:00:00Z"),
  }

  assert.equal(assessOrderReconciliation({
    ...base,
    status: "ready",
    items: [{ itemName: "Soup", fulfillmentStatus: "ready" }],
  }).reconciliationStatus, "ready_to_complete")

  const placed = assessOrderReconciliation({
    ...base,
    status: "placed",
    items: [{ itemName: "Soup" }],
  })
  assert.equal(placed.reconciliationStatus, "prep_not_confirmed")
  assert.equal(placed.preparationEvidence.readyLines, 0)
  assert.equal(placed.preparationEvidence.pendingLines, 1)

  const inProgress = assessOrderReconciliation({
    ...base,
    status: "in_progress",
    items: [{ itemName: "Soup", fulfillmentStatus: "in_progress" }],
  })
  assert.equal(inProgress.reconciliationStatus, "prep_not_confirmed")
  assert.equal(inProgress.preparationEvidence.inProgressLines, 1)

  assert.equal(assessOrderReconciliation({
    ...base,
    status: "ready",
    paymentChannel: "offline",
    paymentStatus: "unpaid",
    items: [{ itemName: "Soup", fulfillmentStatus: "ready" }],
  }).reconciliationStatus, "payment_required")

  const completedOfflineUnpaid = assessOrderReconciliation({
    ...base,
    status: "completed",
    paymentChannel: "offline",
    paymentStatus: "unpaid",
    items: [{ itemName: "Soup", fulfillmentStatus: "ready" }],
  })
  assert.equal(completedOfflineUnpaid.reconciliationStatus, "payment_required")
  assert.equal(completedOfflineUnpaid.canMarkPaid, true)
  assert.equal(completedOfflineUnpaid.canMarkCompleted, false)

  const legacyCorrectionWithoutCompletedStatus = assessOrderReconciliation({
    ...base,
    status: "placed",
    items: [{ itemName: "Soup" }],
    historicalServiceCorrection: {
      confirmedAt: new Date("2026-10-11T10:00:00Z"),
      reason: "Confirmed from the shift handover record",
    },
  })
  // An old correction note is not a substitute for the real completed status.
  // It remains reviewable instead of being silently hidden from the portal.
  assert.equal(legacyCorrectionWithoutCompletedStatus.reconciliationStatus, "prep_not_confirmed")
  assert.equal(legacyCorrectionWithoutCompletedStatus.canMarkCompleted, false)
  assert.equal(legacyCorrectionWithoutCompletedStatus.canMarkPaid, false)

  const combinedIssue = assessOrderReconciliation({
    ...base,
    status: "placed",
    paymentChannel: "offline",
    paymentStatus: "unpaid",
    items: [{ itemName: "Soup" }],
  })
  assert.equal(combinedIssue.reconciliationStatus, "payment_required")
  assert.equal(combinedIssue.canMarkPaid, true)
  assert.equal(combinedIssue.preparationEvidence.pendingLines, 1)

  assert.equal(assessOrderReconciliation({ ...base, status: "cancelled", items: [] }).reconciliationStatus, "cancelled")
})
