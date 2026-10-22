import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import Business from "../src/models/Business.js"
import Order from "../src/models/order.js"
import ServicePoint from "../src/models/ServicePoint.js"
import { markPaidForReconciliation, reconcileComplete } from "../src/controllers/orderController.js"
import { confirmHistoricalServiceCorrection } from "../src/services/historicalOrderCorrectionService.js"

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function businessValues(businessId, slug) {
  return {
    businessId,
    name: `Reconciliation ${businessId}`,
    displayName: `Reconciliation ${businessId}`,
    slug,
    status: "active",
    businessType: "restaurant",
    timezone: "UTC",
    currentPlan: "basic",
    billingStatus: "active",
    defaultPaymentMethodId: "pm_reconciliation_fixture",
    paymentPreferences: {
      acceptOnlinePayments: true,
      acceptOfflinePayments: true,
      acceptCash: true,
      acceptPosCard: true,
    },
  }
}

function orderValues({ orderId, businessId, status = "ready", paymentChannel = "online", paymentStatus = "paid", fulfillmentStatus = "ready", legacyFulfillment = false, inventoryReservationId = null }) {
  return {
    orderId,
    businessId,
    servicePointId: "sp_reconciliation",
    displayLabel: "Table 12",
    status,
    paymentChannel,
    paymentStatus,
    inventoryReservationId,
    commissionRateApplied: 0,
    total: 12,
    subtotal: 12,
    createdAt: new Date("2026-09-01T12:00:00Z"),
    items: [{
      itemName: "Integration Burger",
      quantity: 1,
      lineTotal: 12,
      fulfillmentStation: "kitchen",
      fulfillmentBehavior: "prepared",
      fulfillmentStatus,
      ...(legacyFulfillment ? { orderLineId: null } : {}),
    }],
  }
}

test("real replica-set reconciliation keeps payment, fulfillment, tenants, and retries distinct", {
  skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
  const dbName = `quickserve_reconciliation_${Date.now()}`
  const businessId = "biz_reconciliation"
  const otherBusinessId = "biz_reconciliation_other"
  const actor = { businessId, staffId: "staff_reconciliation", name: "Reconciliation Owner", role: "owner" }
  await mongoose.connect(mongoUri, { dbName })
  try {
    await Promise.all([Business.syncIndexes(), Order.syncIndexes(), ServicePoint.syncIndexes()])
    await Business.create([
      businessValues(businessId, "reconciliation-fixture"),
      businessValues(otherBusinessId, "reconciliation-other"),
    ])
    await ServicePoint.create({
      servicePointId: "sp_reconciliation",
      businessId,
      label: "Table 12",
      code: "T12",
      servicePointType: "table",
      isActive: true,
    })

    await Order.create([
      orderValues({ orderId: "REC-READY", businessId }),
      orderValues({ orderId: "REC-OFFLINE", businessId, paymentChannel: "offline", paymentStatus: "unpaid" }),
      orderValues({ orderId: "REC-REVIEW", businessId, status: "placed", fulfillmentStatus: "pending" }),
      orderValues({ orderId: "REC-HISTORICAL", businessId, status: "placed", fulfillmentStatus: "pending", legacyFulfillment: true }),
      orderValues({ orderId: "REC-INVENTORY-REVIEW", businessId, status: "placed", fulfillmentStatus: "pending", legacyFulfillment: true, inventoryReservationId: "hold_requires_review" }),
      orderValues({ orderId: "REC-RACE", businessId }),
      orderValues({ orderId: "REC-OTHER", businessId: otherBusinessId }),
    ])

    const payment = responseRecorder()
    await markPaidForReconciliation({
      params: { orderId: "REC-OFFLINE" },
      body: { paidVia: "cash" },
      session: { user: actor },
    }, payment)
    assert.equal(payment.statusCode, 200)
    assert.equal(payment.body.automaticReceiptSuppressed, true)
    const paidOffline = await Order.findOne({ businessId, orderId: "REC-OFFLINE" }).lean()
    assert.equal(paidOffline.paymentStatus, "paid")
    assert.equal(paidOffline.reconciliationHistory.length, 1)
    assert.equal(paidOffline.reconciliationHistory[0].operation, "offline_payment_recorded")

    await assert.rejects(
      () => confirmHistoricalServiceCorrection({
        businessId,
        orderId: "REC-READY",
        actor,
        reason: "A ready order must use the existing normal completion path.",
      }),
      { code: "HISTORICAL_CORRECTION_NORMAL_COMPLETION_REQUIRED" },
    )

    const readyCompletion = responseRecorder()
    await reconcileComplete({ params: { orderId: "REC-READY" }, session: { user: actor } }, readyCompletion)
    assert.equal(readyCompletion.statusCode, 200)
    assert.equal(readyCompletion.body.replayed, false)

    const offlineCompletion = responseRecorder()
    await reconcileComplete({ params: { orderId: "REC-OFFLINE" }, session: { user: actor } }, offlineCompletion)
    assert.equal(offlineCompletion.statusCode, 200)
    assert.equal(offlineCompletion.body.replayed, false)

    const crossTenantCompletion = responseRecorder()
    await reconcileComplete({ params: { orderId: "REC-OTHER" }, session: { user: actor } }, crossTenantCompletion)
    assert.equal(crossTenantCompletion.statusCode, 404)
    assert.equal(crossTenantCompletion.body.code, "ORDER_NOT_FOUND")

    assert.equal((await Order.findOne({ businessId, orderId: "REC-READY" }).lean()).status, "completed")
    assert.equal((await Order.findOne({ businessId, orderId: "REC-OFFLINE" }).lean()).status, "completed")
    assert.equal((await Order.findOne({ businessId, orderId: "REC-READY" }).lean()).reconciliationHistory[0].operation, "normal_completion")
    assert.equal((await Order.findOne({ businessId, orderId: "REC-OFFLINE" }).lean()).reconciliationHistory.length, 2)
    assert.equal((await Order.findOne({ businessId, orderId: "REC-REVIEW" }).lean()).status, "placed")
    assert.equal((await Order.findOne({ businessId: otherBusinessId, orderId: "REC-OTHER" }).lean()).status, "ready")

    const historical = await confirmHistoricalServiceCorrection({ businessId, orderId: "REC-HISTORICAL", actor })
    assert.equal(historical.changed, true)
    const corrected = await Order.findOne({ businessId, orderId: "REC-HISTORICAL" }).lean()
    assert.equal(corrected.status, "completed")
    assert.ok(corrected.completedAt)
    assert.equal(corrected.items[0].fulfillmentStatus, "pending")
    assert.equal(corrected.servedAt, null)
    assert.equal(corrected.historicalServiceCorrection.type, "served_without_recorded_preparation")
    assert.equal(corrected.historicalServiceCorrection.reason, null)
    assert.equal(corrected.historicalServiceCorrection.inventoryDisposition, "unchanged")
    assert.equal(corrected.reconciliationHistory.length, 1)
    assert.equal(corrected.reconciliationHistory[0].operation, "administrative_completion")
    assert.equal(corrected.reconciliationHistory[0].before.status, "placed")
    assert.equal(corrected.reconciliationHistory[0].after.status, "completed")

    const historicalReplay = await confirmHistoricalServiceCorrection({
      businessId,
      orderId: "REC-HISTORICAL",
      actor,
      reason: "A different reason cannot replace the original correction.",
    })
    assert.equal(historicalReplay.replayed, true)

    const waiterReplay = await confirmHistoricalServiceCorrection({
      businessId,
      orderId: "REC-HISTORICAL",
      actor: { ...actor, staffId: "WTR-reconciliation", name: "Sarah", role: "waiter" },
      reason: "A duplicate correction cannot overwrite the original reconciliation.",
    })
    assert.equal(waiterReplay.replayed, true)
    const inventoryCorrection = await confirmHistoricalServiceCorrection({
      businessId,
      orderId: "REC-INVENTORY-REVIEW",
      actor,
      reason: "Confirmed from the handover. Stock use is not known with certainty.",
    })
    assert.equal(inventoryCorrection.changed, true)
    const inventoryCorrected = await Order.findOne({ businessId, orderId: "REC-INVENTORY-REVIEW" }).lean()
    assert.equal(inventoryCorrected.status, "completed")
    assert.equal(inventoryCorrected.inventoryReservationId, "hold_requires_review")
    assert.equal(inventoryCorrected.inventoryReleased, false)
    assert.equal(inventoryCorrected.historicalServiceCorrection.inventoryDisposition, "unchanged_with_existing_reservation")

    // A modern order with incomplete preparation evidence can also be
    // reconciled by authorized management. Its actual evidence remains intact.
    const modernCorrection = await confirmHistoricalServiceCorrection({
      businessId,
      orderId: "REC-REVIEW",
      actor,
      reason: "The shift record and waiter handover both confirm it was served.",
    })
    assert.equal(modernCorrection.changed, true)
    const modernCorrected = await Order.findOne({ businessId, orderId: "REC-REVIEW" }).lean()
    assert.equal(modernCorrected.status, "completed")
    assert.equal(modernCorrected.items[0].fulfillmentStatus, "pending")
    assert.equal(modernCorrected.servedAt, null)

    await Order.create(orderValues({ orderId: "REC-WAITER-REVIEW", businessId, status: "placed", fulfillmentStatus: "pending" }))
    const waiterCorrection = await confirmHistoricalServiceCorrection({
      businessId,
      orderId: "REC-WAITER-REVIEW",
      actor: { ...actor, staffId: "WTR-reconciliation", name: "Sarah", role: "waiter" },
      reason: "The handover record confirms that the order was served.",
    })
    assert.equal(waiterCorrection.changed, true)
    const waiterCorrected = await Order.findOne({ businessId, orderId: "REC-WAITER-REVIEW" }).lean()
    assert.equal(waiterCorrected.status, "completed")
    assert.equal(waiterCorrected.reconciliationHistory[0].performedBy.name, "Sarah")
    await assert.rejects(
      () => confirmHistoricalServiceCorrection({
        businessId,
        orderId: "REC-OTHER",
        actor,
        reason: "Cross-tenant order access must not be possible here.",
      }),
      { code: "ORDER_NOT_FOUND" },
    )

    await Order.create(orderValues({ orderId: "REC-HISTORICAL-RACE", businessId, status: "placed", fulfillmentStatus: "pending", legacyFulfillment: true }))
    const historicalRace = await Promise.all([
      confirmHistoricalServiceCorrection({ businessId, orderId: "REC-HISTORICAL-RACE", actor, reason: "Confirmed from the shift handover and service record." }),
      confirmHistoricalServiceCorrection({ businessId, orderId: "REC-HISTORICAL-RACE", actor, reason: "Confirmed from the shift handover and service record." }),
    ])
    assert.equal(historicalRace.filter((result) => result.changed).length, 1)
    assert.equal(historicalRace.filter((result) => result.replayed).length, 1)

    const [firstAttempt, secondAttempt] = await Promise.all([
      (async () => {
        const response = responseRecorder()
        await reconcileComplete({ params: { orderId: "REC-RACE" }, session: { user: actor } }, response)
        return response
      })(),
      (async () => {
        const response = responseRecorder()
        await reconcileComplete({ params: { orderId: "REC-RACE" }, session: { user: actor } }, response)
        return response
      })(),
    ])
    assert.equal(firstAttempt.statusCode, 200)
    assert.equal(secondAttempt.statusCode, 200)
    const raceOutcomes = [firstAttempt.body, secondAttempt.body]
    assert.equal(raceOutcomes.filter((result) => result.success).length, 2)
    assert.equal(raceOutcomes.filter((result) => !result.replayed).length, 1)
    assert.equal(raceOutcomes.filter((result) => result.replayed).length, 1)
    assert.equal((await Order.findOne({ businessId, orderId: "REC-RACE" }).lean()).status, "completed")
  } finally {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})
