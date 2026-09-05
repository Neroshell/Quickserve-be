import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import Business from "../src/models/Business.js"
import CustomerJourney from "../src/models/CustomerJourney.js"
import GuestSession from "../src/models/GuestSession.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import PendingCheckout from "../src/models/PendingCheckout.js"
import Plan from "../src/models/Plan.js"
import ServicePoint from "../src/models/ServicePoint.js"
import {
  completeOrderForWaitstaff,
  createOrderLineFulfillmentSnapshot,
  transitionOrderFulfillment,
} from "../src/services/orderFulfillmentService.js"
import { toOrderDTO } from "../src/utils/orderDTO.js"

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
  }
}

function lineSnapshot(item) {
  return {
    orderLineId: item.orderLineId || null,
    type: item.type,
    fulfillmentStation: item.fulfillmentStation || null,
    fulfillmentBehavior: item.fulfillmentBehavior || null,
    fulfillmentStatus: item.fulfillmentStatus || null,
  }
}

function semanticSnapshot(item) {
  const { orderLineId: _orderLineId, ...semantic } = lineSnapshot(item)
  return semantic
}

async function seedParityRestaurant() {
  const alwaysOpen = Object.fromEntries(
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
      .map((day) => [day, { enabled: true, openTime: "00:00", closeTime: "23:59" }]),
  )
  await Plan.create({
    name: "Basic Phase 5 Parity",
    slug: "basic",
    level: 1,
    commissionPercentage: 2,
    offlineCommissionRate: 2,
    monthlyPrice: 0,
  })
  await Business.create({
    businessId: "biz_phase5_parity",
    name: "Phase 5 Parity Restaurant",
    displayName: "Phase 5 Parity Restaurant",
    slug: "phase-5-parity-restaurant",
    status: "active",
    businessType: "restaurant",
    currentPlan: "basic",
    currency: "EUR",
    timezone: "Europe/Berlin",
    operatingHours: alwaysOpen,
    billingStatus: "active",
    defaultPaymentMethodId: "pm_phase5_parity",
    stripeAccountId: "acct_phase5_parity",
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    paymentPreferences: {
      acceptOnlinePayments: true,
      acceptOfflinePayments: true,
      acceptCash: true,
      acceptPosCard: true,
    },
    orderingPreferences: {
      dineInEnabled: true,
      qrOrderingEnabled: true,
      enableWaiterOrdering: true,
    },
  })
  await ServicePoint.create({
    servicePointId: "sp_phase5_parity",
    businessId: "biz_phase5_parity",
    label: "Table 5",
    code: "T5",
    servicePointType: "table",
    isActive: true,
  })
  const items = await MenuItem.create([
    {
      businessId: "biz_phase5_parity",
      name: "Negroni Cocktail",
      price: 12,
      category: "cocktails",
      type: "drinks",
      fulfillmentStation: "bar",
      fulfillmentBehavior: "prepared",
      prepTimeMinutes: 5,
    },
    {
      businessId: "biz_phase5_parity",
      name: "Sprite",
      price: 4,
      category: "soft-drinks",
      type: "drinks",
      fulfillmentStation: "bar",
      fulfillmentBehavior: "direct",
      prepTimeMinutes: null,
    },
    {
      businessId: "biz_phase5_parity",
      name: "Cheeseburger",
      price: 15,
      category: "mains",
      type: "food",
      fulfillmentStation: "kitchen",
      fulfillmentBehavior: "prepared",
      prepTimeMinutes: 8,
    },
  ])
  return Object.fromEntries(items.map((item) => [item.name, item]))
}

function customerRequest({ token, sessionId, items, idempotencyKey, stripe }) {
  return {
    body: {
      servicePointLabel: "sp_phase5_parity",
      tableSessionToken: token,
      sessionId,
      orderType: "dine-in",
      items,
    },
    headers: { "idempotency-key": idempotencyKey },
    get(name) { return this.headers[name.toLowerCase()] },
    session: {},
    app: {
      locals: {
        ...(stripe ? { stripe } : {}),
        enqueueInventoryReservationReconciliation: async () => ({ queued: false }),
      },
    },
  }
}

function paidCheckoutEvent(pending) {
  return {
    id: `evt_${pending.orderId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: pending.stripeSessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: pending.grossAmount,
        currency: pending.currency.toLowerCase(),
        payment_intent: pending.stripePaymentIntentId,
        metadata: {
          pendingCheckoutId: pending._id.toString(),
          orderId: pending.orderId,
          businessId: pending.businessId,
          ...(pending.inventoryReservationId
            ? { inventoryReservationId: pending.inventoryReservationId }
            : {}),
        },
      },
    },
  }
}

test("simultaneous Kitchen and Bar transitions preserve both stations and do not mutate inventory", {
  skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
  const dbName = `quickserve_fulfillment_${Date.now()}`
  await mongoose.connect(mongoUri, { dbName })
  try {
    await Promise.all([Order.syncIndexes(), MenuItem.syncIndexes(), InventoryItem.syncIndexes(), InventoryMovement.syncIndexes()])
    const menuItems = await MenuItem.create([
      {
        businessId: "biz_phase5", name: "Burger", price: 10, category: "mains", type: "food",
        fulfillmentStation: "kitchen", fulfillmentBehavior: "prepared", prepTimeMinutes: 8,
      },
      {
        businessId: "biz_phase5", name: "Mojito", price: 7, category: "drinks", type: "drinks",
        fulfillmentStation: "bar", fulfillmentBehavior: "prepared", prepTimeMinutes: 4,
      },
      {
        businessId: "biz_phase5", name: "Water", price: 3, category: "drinks", type: "drinks",
        fulfillmentStation: "bar", fulfillmentBehavior: "direct", prepTimeMinutes: null,
      },
    ])
    assert.deepEqual(menuItems.map((item) => [item.fulfillmentStation, item.fulfillmentBehavior]), [
      ["kitchen", "prepared"], ["bar", "prepared"], ["bar", "direct"],
    ])
    const frozenFoodSnapshot = createOrderLineFulfillmentSnapshot(menuItems[0])
    menuItems[0].fulfillmentStation = "kitchen"
    menuItems[0].fulfillmentBehavior = "prepared"
    menuItems[0].archivedAt = new Date()
    await menuItems[0].save()
    assert.equal(frozenFoodSnapshot.fulfillmentStation, "kitchen")
    assert.equal(frozenFoodSnapshot.fulfillmentBehavior, "prepared")
    await InventoryItem.create({
      inventoryItemId: "inv_phase5_non_regression",
      businessId: "biz_phase5",
      name: "Phase 5 Inventory Sentinel",
      trackingUnit: "piece",
      baseUnitDimension: "count",
      onHandQuantity: 20,
      reservedQuantity: 4,
      lowStockThreshold: 2,
    })
    await Order.create({
      orderId: "ord_phase5_concurrent",
      businessId: "biz_phase5",
      servicePointLabel: "sp_phase5",
      status: "placed",
      paymentChannel: "online",
      paymentStatus: "paid",
      inventoryReservationId: "res_phase5_existing",
      inventoryReserved: true,
      inventoryReservedAt: new Date(),
      inventorySemanticsVersion: "canonical_reservation_v1",
      items: [
        {
          orderLineId: "line_kitchen",
          itemName: "Burger",
          quantity: 2,
          lineTotal: 20,
          type: "food",
          fulfillmentStation: "kitchen",
          fulfillmentBehavior: "prepared",
          fulfillmentStatus: "pending",
        },
        {
          orderLineId: "line_bar",
          itemName: "Water",
          quantity: 2,
          lineTotal: 6,
          type: "drinks",
          fulfillmentStation: "bar",
          fulfillmentBehavior: "direct",
          fulfillmentStatus: "pending",
        },
      ],
    })

    const actor = { staffId: "staff_phase5", name: "Phase 5", role: "manager" }
    await Promise.all([
      transitionOrderFulfillment({
        businessId: "biz_phase5",
        orderId: "ord_phase5_concurrent",
        station: "kitchen",
        action: "start",
        actor,
      }),
      transitionOrderFulfillment({
        businessId: "biz_phase5",
        orderId: "ord_phase5_concurrent",
        station: "bar",
        action: "ready",
        orderLineIds: ["line_bar"],
        actor,
      }),
    ])

    let stored = await Order.findOne({ orderId: "ord_phase5_concurrent" }).lean()
    assert.equal(stored.items.find((item) => item.orderLineId === "line_kitchen").fulfillmentStatus, "in_progress")
    assert.equal(stored.items.find((item) => item.orderLineId === "line_bar").fulfillmentStatus, "ready")
    assert.equal(stored.status, "in_progress")
    assert.equal(stored.inventoryReservationId, "res_phase5_existing")
    assert.equal(stored.inventoryReserved, true)

    await transitionOrderFulfillment({
      businessId: "biz_phase5",
      orderId: "ord_phase5_concurrent",
      station: "kitchen",
      action: "ready",
      actor,
    })
    stored = await Order.findOne({ orderId: "ord_phase5_concurrent" }).lean()
    assert.equal(stored.status, "ready")

    await completeOrderForWaitstaff({
      businessId: "biz_phase5",
      orderId: "ord_phase5_concurrent",
      actor: { ...actor, role: "waiter" },
    })
    stored = await Order.findOne({ orderId: "ord_phase5_concurrent" }).lean()
    assert.equal(stored.status, "completed")

    const inventory = await InventoryItem.findOne({
      businessId: "biz_phase5",
      inventoryItemId: "inv_phase5_non_regression",
    }).lean()
    assert.equal(inventory.onHandQuantity, 20)
    assert.equal(inventory.reservedQuantity, 4)
    assert.equal(await InventoryMovement.countDocuments({ businessId: "biz_phase5" }), 0)
  } finally {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})

test("offline and Stripe orders preserve equivalent frozen fulfilment snapshots through Bar projection", {
  skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
  process.env.REDIS_URL = ""
  process.env.BULLMQ_EMAILS_ENABLED = "false"
  process.env.BULLMQ_INVENTORY_SCHEDULERS_ENABLED = "false"
  process.env.STRIPE_SECRET_KEY = "sk_test_phase5_parity"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_phase5_parity"
  process.env.RESEND_API_KEY = "re_test_phase5_parity"
  process.env.FRONTEND_BASE_URL = "https://app.quickserve.test"

  const [{ createOrder }, { createCheckoutSession }, { handleStripeWebhook }, { barOrders }] =
    await Promise.all([
      import("../src/controllers/orderController.js"),
      import("../src/controllers/paymentController.js"),
      import("../src/controllers/webhookController.js"),
      import("../src/controllers/barController.js"),
    ])

  const dbName = `quickserve_fulfillment_parity_${Date.now()}`
  await mongoose.connect(mongoUri, { dbName })
  try {
    await Promise.all([
      Business.syncIndexes(),
      CustomerJourney.syncIndexes(),
      GuestSession.syncIndexes(),
      InventoryItem.syncIndexes(),
      InventoryMovement.syncIndexes(),
      InventoryReservation.syncIndexes(),
      MenuInventoryRecipe.syncIndexes(),
      MenuItem.syncIndexes(),
      Order.syncIndexes(),
      PendingCheckout.syncIndexes(),
      Plan.syncIndexes(),
      ServicePoint.syncIndexes(),
    ])
    const menu = await seedParityRestaurant()
    await GuestSession.create([
      {
        businessId: "biz_phase5_parity",
        servicePointId: "sp_phase5_parity",
        token: "phase5-offline-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        businessId: "biz_phase5_parity",
        servicePointId: "sp_phase5_parity",
        token: "phase5-online-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        businessId: "biz_phase5_parity",
        servicePointId: "sp_phase5_parity",
        token: "phase5-recovery-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        businessId: "biz_phase5_parity",
        servicePointId: "sp_phase5_parity",
        token: "phase5-canonical-recovery-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ])

    const cart = [
      { itemName: "Negroni Cocktail", quantity: 1 },
      { itemName: "Sprite", quantity: 1 },
      { itemName: "Cheeseburger", quantity: 1 },
    ]
    const offlineResponse = responseRecorder()
    await createOrder(customerRequest({
      token: "phase5-offline-token",
      sessionId: "phase5-offline-device",
      items: cart,
      idempotencyKey: "phase5-offline-order",
    }), offlineResponse)
    assert.equal(offlineResponse.statusCode, 201, JSON.stringify(offlineResponse.body))
    const offlineOrder = await Order.findOne({ orderId: offlineResponse.body.orderId }).lean()

    let stripeSequence = 0
    const stripe = {
      checkout: {
        sessions: {
          async create(config) {
            stripeSequence += 1
            return {
              id: `cs_phase5_parity_${stripeSequence}`,
              url: `https://checkout.stripe.test/phase5/${stripeSequence}`,
              payment_intent: `pi_phase5_parity_${stripeSequence}`,
              expires_at: config.expires_at,
              status: "open",
            }
          },
        },
      },
    }
    const onlineResponse = responseRecorder()
    await createCheckoutSession(customerRequest({
      token: "phase5-online-token",
      sessionId: "phase5-online-device",
      items: cart,
      idempotencyKey: "phase5-online-checkout",
      stripe,
    }), onlineResponse)
    assert.equal(onlineResponse.statusCode, 201)

    const pending = await PendingCheckout.findOne({
      businessId: "biz_phase5_parity",
      idempotencyKey: "checkout:phase5-online-checkout",
    }).lean()
    assert.deepEqual(pending.items.map(semanticSnapshot), offlineOrder.items.map(semanticSnapshot))

    // The PendingCheckout, not the live MenuItem, remains authoritative.
    await MenuItem.updateOne({ _id: menu["Negroni Cocktail"]._id }, {
      $set: { fulfillmentBehavior: "direct", prepTimeMinutes: null },
    })
    const webhookResponse = responseRecorder()
    await handleStripeWebhook({
      stripeWebhookEvent: paidCheckoutEvent(pending),
      headers: {},
      app: { locals: {} },
    }, webhookResponse)
    assert.equal(webhookResponse.statusCode, 200)

    const onlineOrder = await Order.findOne({ orderId: pending.orderId }).lean()
    assert.deepEqual(onlineOrder.items.map(semanticSnapshot), offlineOrder.items.map(semanticSnapshot))
    assert.deepEqual(
      toOrderDTO(onlineOrder).customerProgress,
      toOrderDTO(offlineOrder).customerProgress,
    )
    assert.deepEqual(lineSnapshot(onlineOrder.items[0]), {
      orderLineId: pending.items[0].orderLineId,
      type: "drinks",
      fulfillmentStation: "bar",
      fulfillmentBehavior: "prepared",
      fulfillmentStatus: "pending",
    })
    const duplicateEvent = paidCheckoutEvent(pending)
    duplicateEvent.id = `${duplicateEvent.id}_duplicate`
    const duplicateResponse = responseRecorder()
    await handleStripeWebhook({
      stripeWebhookEvent: duplicateEvent,
      headers: {},
      app: { locals: {} },
    }, duplicateResponse)
    assert.equal(duplicateResponse.statusCode, 200)
    assert.equal(await Order.countDocuments({ orderId: pending.orderId }), 1)
    assert.deepEqual(
      (await Order.findOne({ orderId: pending.orderId }).lean()).items.map(semanticSnapshot),
      offlineOrder.items.map(semanticSnapshot),
    )

    const barResponse = responseRecorder()
    await barOrders({
      session: { user: { role: "bartender", businessId: "biz_phase5_parity" } },
    }, barResponse)
    assert.equal(barResponse.statusCode, 200)
    const projectedOffline = barResponse.body.orders.find(
      (order) => order.orderId === offlineOrder.orderId,
    )
    const projectedOnline = barResponse.body.orders.find(
      (order) => order.orderId === onlineOrder.orderId,
    )
    assert.ok(projectedOffline)
    assert.ok(projectedOnline)
    assert.deepEqual(
      projectedOnline.items.map(semanticSnapshot),
      projectedOffline.items.map(semanticSnapshot),
    )

    // Recovery case: a previously-created Order has legacy drink fields while
    // the retained PendingCheckout still has the authoritative prepared line.
    const recoveryCheckoutResponse = responseRecorder()
    await MenuItem.updateOne({ _id: menu["Negroni Cocktail"]._id }, {
      $set: { fulfillmentBehavior: "prepared", prepTimeMinutes: 5 },
    })
    await createCheckoutSession(customerRequest({
      token: "phase5-recovery-token",
      sessionId: "phase5-recovery-device",
      items: [{ itemName: "Negroni Cocktail", quantity: 1 }],
      idempotencyKey: "phase5-recovery-checkout",
      stripe,
    }), recoveryCheckoutResponse)
    assert.equal(recoveryCheckoutResponse.statusCode, 201)
    const recoveryPending = await PendingCheckout.findOne({
      businessId: "biz_phase5_parity",
      idempotencyKey: "checkout:phase5-recovery-checkout",
    }).lean()
    assert.equal(recoveryPending.items[0].fulfillmentBehavior, "prepared")

    await MenuItem.updateOne({ _id: menu["Negroni Cocktail"]._id }, {
      $set: { fulfillmentBehavior: "direct", prepTimeMinutes: null },
    })
    await Order.create({
      businessId: recoveryPending.businessId,
      orderId: recoveryPending.orderId,
      servicePointLabel: recoveryPending.servicePointLabel,
      displayLabel: recoveryPending.displayLabel,
      orderType: recoveryPending.orderType,
      sessionId: recoveryPending.sessionId,
      status: "placed",
      items: recoveryPending.items.map((item) => ({
        menuItemId: item.menuItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        type: item.type,
        category: item.category,
      })),
      subtotal: recoveryPending.subtotal,
      total: recoveryPending.total,
      currency: recoveryPending.currency,
      paymentChannel: "online",
      paymentStatus: "pending",
    })
    const recoveryResponse = responseRecorder()
    await handleStripeWebhook({
      stripeWebhookEvent: paidCheckoutEvent(recoveryPending),
      headers: {},
      app: { locals: {} },
    }, recoveryResponse)
    assert.equal(recoveryResponse.statusCode, 200)
    const recoveredOrder = await Order.findOne({ orderId: recoveryPending.orderId }).lean()
    assert.equal(recoveredOrder.items[0].fulfillmentStation, "bar")
    assert.equal(recoveredOrder.items[0].fulfillmentBehavior, "prepared")
    assert.equal(recoveredOrder.items[0].fulfillmentStatus, "pending")

    // The same recovery rule also applies inside Phase 4's transactional paid
    // order finalizer when a checkout has a canonical inventory reservation.
    await InventoryItem.create({
      inventoryItemId: "inv_phase5_negroni",
      businessId: "biz_phase5_parity",
      name: "Bottled Negroni",
      trackingUnit: "piece",
      baseUnitDimension: "count",
      onHandQuantity: 10,
      reservedQuantity: 0,
      lowStockThreshold: 0,
    })
    await MenuInventoryRecipe.create({
      menuInventoryRecipeId: "mir_phase5_negroni",
      businessId: "biz_phase5_parity",
      menuItemId: menu["Negroni Cocktail"]._id,
      mode: "simple",
      status: "active",
      version: 1,
      components: [{
        inventoryItemId: "inv_phase5_negroni",
        quantity: 1,
        unit: "piece",
        canonicalQuantity: 1,
      }],
    })
    await MenuItem.updateOne({ _id: menu["Negroni Cocktail"]._id }, {
      $set: {
        fulfillmentBehavior: "prepared",
        prepTimeMinutes: 5,
        trackStock: true,
        stockQuantity: 0,
      },
    })
    const canonicalCheckoutResponse = responseRecorder()
    await createCheckoutSession(customerRequest({
      token: "phase5-canonical-recovery-token",
      sessionId: "phase5-canonical-recovery-device",
      items: [{ itemName: "Negroni Cocktail", quantity: 1 }],
      idempotencyKey: "phase5-canonical-recovery-checkout",
      stripe,
    }), canonicalCheckoutResponse)
    assert.equal(canonicalCheckoutResponse.statusCode, 201)
    const canonicalPending = await PendingCheckout.findOne({
      businessId: "biz_phase5_parity",
      idempotencyKey: "checkout:phase5-canonical-recovery-checkout",
    }).lean()
    assert.ok(canonicalPending.inventoryReservationId)
    assert.equal(canonicalPending.items[0].fulfillmentBehavior, "prepared")

    await MenuItem.updateOne({ _id: menu["Negroni Cocktail"]._id }, {
      $set: { fulfillmentBehavior: "direct", prepTimeMinutes: null },
    })
    await Order.create({
      businessId: canonicalPending.businessId,
      orderId: canonicalPending.orderId,
      servicePointLabel: canonicalPending.servicePointLabel,
      displayLabel: canonicalPending.displayLabel,
      orderType: canonicalPending.orderType,
      sessionId: canonicalPending.sessionId,
      status: "placed",
      items: canonicalPending.items.map((item) => ({
        menuItemId: item.menuItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        type: item.type,
        category: item.category,
      })),
      subtotal: canonicalPending.subtotal,
      total: canonicalPending.total,
      currency: canonicalPending.currency,
      paymentChannel: "online",
      paymentStatus: "pending",
    })
    const canonicalRecoveryResponse = responseRecorder()
    await handleStripeWebhook({
      stripeWebhookEvent: paidCheckoutEvent(canonicalPending),
      headers: {},
      app: { locals: {} },
    }, canonicalRecoveryResponse)
    assert.equal(canonicalRecoveryResponse.statusCode, 200)
    const canonicalRecoveredOrder = await Order.findOne({ orderId: canonicalPending.orderId }).lean()
    assert.equal(canonicalRecoveredOrder.items[0].fulfillmentStation, "bar")
    assert.equal(canonicalRecoveredOrder.items[0].fulfillmentBehavior, "prepared")
    assert.equal(canonicalRecoveredOrder.items[0].fulfillmentStatus, "pending")
    const canonicalDuplicateEvent = paidCheckoutEvent(canonicalPending)
    canonicalDuplicateEvent.id = `${canonicalDuplicateEvent.id}_duplicate`
    const canonicalDuplicateResponse = responseRecorder()
    await handleStripeWebhook({
      stripeWebhookEvent: canonicalDuplicateEvent,
      headers: {},
      app: { locals: {} },
    }, canonicalDuplicateResponse)
    assert.equal(canonicalDuplicateResponse.statusCode, 200)
    assert.equal(await Order.countDocuments({ orderId: canonicalPending.orderId }), 1)
    assert.equal(
      (await Order.findOne({ orderId: canonicalPending.orderId }).lean())
        .items[0].fulfillmentBehavior,
      "prepared",
    )
    const inventory = await InventoryItem.findOne({
      businessId: "biz_phase5_parity",
      inventoryItemId: "inv_phase5_negroni",
    }).lean()
    assert.equal(inventory.onHandQuantity, 10)
    assert.equal(inventory.reservedQuantity, 1)
    assert.equal(await InventoryMovement.countDocuments({
      businessId: "biz_phase5_parity",
      type: "CONSUME",
    }), 0)
    assert.equal(await InventoryMovement.countDocuments({
      businessId: "biz_phase5_parity",
      type: "RESERVE",
    }), 1)
  } finally {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})
