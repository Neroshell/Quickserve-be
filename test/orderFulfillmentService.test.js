import assert from "node:assert/strict"
import test from "node:test"

import {
  completeOrderForWaitstaff,
  createOrderLineFulfillmentSnapshot,
  deriveOrderStatusFromLines,
  getCustomerOrderProgress,
  getCustomerOrderStatusMessage,
  normalizeMenuFulfillmentConfiguration,
  reconcileFrozenCheckoutFulfillment,
  resolveMenuItemFulfillment,
  transitionOrderFulfillment,
} from "../src/services/orderFulfillmentService.js"
import { toOrderDTO } from "../src/utils/orderDTO.js"
import MenuItem from "../src/models/menuItem.js"
import Business from "../src/models/Business.js"
import { DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES } from "../src/utils/customerOrderTiming.js"
import fs from "node:fs"

const actor = { staffId: "staff_1", name: "Alex", role: "kitchen" }
const barActor = { ...actor, role: "bartender" }
const waiterActor = { ...actor, role: "waiter" }
const PROJECTION_NOW = new Date("2026-09-04T12:01:00.000Z")

function line({
  id,
  type = "food",
  station = type === "drinks" ? "bar" : "kitchen",
  behavior = type === "drinks" ? "direct" : "prepared",
  status = "pending",
  prepTimeMinutes = behavior === "prepared" ? 10 : null,
  startedAt = status === "in_progress" ? new Date("2026-09-04T12:00:00.000Z") : null,
  readyAt = status === "ready" ? new Date("2026-09-04T12:00:00.000Z") : null,
} = {}) {
  return {
    orderLineId: id || `line_${Math.random()}`,
    itemName: type === "drinks" ? "Drink" : "Food",
    quantity: 1,
    lineTotal: 10,
    type,
    prepTimeMinutes,
    fulfillmentStation: station,
    fulfillmentBehavior: behavior,
    fulfillmentStatus: status,
    fulfillmentStartedAt: startedAt,
    fulfillmentStartedBy: null,
    fulfillmentReadyAt: readyAt,
    fulfillmentReadyBy: null,
  }
}

function fakeDependencies(order, now = new Date("2026-09-04T12:00:00.000Z")) {
  order.saveCount = 0
  order.save = async function save() {
    this.saveCount += 1
    this.updatedAt = now
    return this
  }
  return {
    OrderModel: { findOne: async (query) => (
      query.businessId === order.businessId && query.orderId === order.orderId ? order : null
    ) },
    runTransaction: async (work) => work({ id: "fake_session" }),
    now: () => now,
  }
}

test("menu fulfilment is explicit and locked to Kitchen/Bar semantics", () => {
  assert.deepEqual(resolveMenuItemFulfillment({ type: "food" }), {
    station: "kitchen", behavior: "prepared", explicit: false,
  })
  assert.deepEqual(resolveMenuItemFulfillment({ type: "drinks" }), {
    station: "bar", behavior: "direct", explicit: false,
  })
  assert.equal(resolveMenuItemFulfillment({
    type: "drinks", fulfillmentStation: "bar", fulfillmentBehavior: "prepared",
  }).behavior, "prepared")

  assert.deepEqual(normalizeMenuFulfillmentConfiguration({
    type: "drinks", fulfillmentBehavior: "direct", prepTimeMinutes: 99,
  }), {
    type: "drinks", fulfillmentStation: "bar", fulfillmentBehavior: "direct", prepTimeMinutes: null,
  })
  assert.throws(
    () => normalizeMenuFulfillmentConfiguration({ type: "food", fulfillmentStation: "bar", prepTimeMinutes: 5 }),
    { code: "INVALID_FULFILLMENT_STATION" },
  )
  assert.throws(
    () => normalizeMenuFulfillmentConfiguration({ type: "drinks", fulfillmentBehavior: "prepared" }),
    { code: "INVALID_PREPARATION_TIME" },
  )
})

test("new order lines receive unique server snapshots and start pending", () => {
  const first = createOrderLineFulfillmentSnapshot(
    { type: "food" },
    { orderLineId: "client_chosen_identity" },
  )
  const second = createOrderLineFulfillmentSnapshot({ type: "drinks" })
  assert.match(first.orderLineId, /^oln_[a-f0-9]{24}$/)
  assert.notEqual(first.orderLineId, second.orderLineId)
  assert.notEqual(first.orderLineId, "client_chosen_identity")
  assert.deepEqual(
    [first.fulfillmentStation, first.fulfillmentBehavior, first.fulfillmentStatus],
    ["kitchen", "prepared", "pending"],
  )
  assert.deepEqual(
    [second.fulfillmentStation, second.fulfillmentBehavior, second.fulfillmentStatus],
    ["bar", "direct", "pending"],
  )
})

test("Kitchen prepared, Bar prepared, and Bar direct MenuItems persist valid explicit configuration", async () => {
  const values = [
    { type: "food", fulfillmentStation: "kitchen", fulfillmentBehavior: "prepared", prepTimeMinutes: 8 },
    { type: "drinks", fulfillmentStation: "bar", fulfillmentBehavior: "prepared", prepTimeMinutes: 4 },
    { type: "drinks", fulfillmentStation: "bar", fulfillmentBehavior: "direct", prepTimeMinutes: null },
  ]
  for (const [index, fulfillment] of values.entries()) {
    const item = new MenuItem({
      businessId: "biz_menu",
      name: `Menu ${index}`,
      price: 5,
      category: "mains",
      ...fulfillment,
    })
    await item.validate()
    assert.equal(item.fulfillmentStation, fulfillment.fulfillmentStation)
    assert.equal(item.fulfillmentBehavior, fulfillment.fulfillmentBehavior)
    assert.equal(item.prepTimeMinutes, fulfillment.prepTimeMinutes)
  }
})

test("order snapshot remains frozen after its MenuItem is edited or archived", () => {
  const menuItem = {
    type: "drinks",
    fulfillmentStation: "bar",
    fulfillmentBehavior: "prepared",
  }
  const snapshot = createOrderLineFulfillmentSnapshot(menuItem)
  menuItem.fulfillmentBehavior = "direct"
  menuItem.archivedAt = new Date()
  assert.equal(snapshot.fulfillmentStation, "bar")
  assert.equal(snapshot.fulfillmentBehavior, "prepared")
  assert.equal(snapshot.fulfillmentStatus, "pending")
})

test("checkout recovery hydrates only from the frozen snapshot and never weakens prepared lines", () => {
  const frozenPrepared = {
    ...line({ id: "pending_negroni", type: "drinks", behavior: "prepared" }),
    menuItemId: "menu_negroni",
    itemName: "Negroni Cocktail",
  }
  const legacyOrder = {
    items: [{
      orderLineId: "legacy_generated_id",
      menuItemId: "menu_negroni",
      itemName: "Negroni Cocktail",
      quantity: 1,
      type: "drinks",
    }],
  }

  assert.equal(reconcileFrozenCheckoutFulfillment(legacyOrder, [frozenPrepared]), true)
  assert.deepEqual({
    orderLineId: legacyOrder.items[0].orderLineId,
    station: legacyOrder.items[0].fulfillmentStation,
    behavior: legacyOrder.items[0].fulfillmentBehavior,
    status: legacyOrder.items[0].fulfillmentStatus,
  }, {
    orderLineId: "pending_negroni",
    station: "bar",
    behavior: "prepared",
    status: "pending",
  })

  const progressedPrepared = {
    ...frozenPrepared,
    orderLineId: "operational_line_id",
    fulfillmentStatus: "ready",
    fulfillmentReadyAt: new Date("2026-09-04T13:00:00.000Z"),
  }
  const frozenDirect = {
    ...frozenPrepared,
    orderLineId: "pending_direct_id",
    fulfillmentBehavior: "direct",
  }
  assert.equal(reconcileFrozenCheckoutFulfillment(
    { items: [progressedPrepared] },
    [frozenDirect],
  ), false)
  assert.equal(progressedPrepared.orderLineId, "operational_line_id")
  assert.equal(progressedPrepared.fulfillmentBehavior, "prepared")
  assert.equal(progressedPrepared.fulfillmentStatus, "ready")
})

test("global order progress is derived from every line", () => {
  assert.equal(deriveOrderStatusFromLines([line(), line({ type: "drinks" })]), "placed")
  assert.equal(deriveOrderStatusFromLines([line({ status: "in_progress" }), line({ type: "drinks" })]), "in_progress")
  assert.equal(deriveOrderStatusFromLines([line({ status: "ready" }), line({ type: "drinks" })]), "in_progress")
  assert.equal(deriveOrderStatusFromLines([line({ status: "ready" }), line({ type: "drinks", status: "ready" })]), "ready")
})

test("Kitchen transitions only Kitchen prepared lines and retries do not reset timestamps", async () => {
  const order = {
    orderId: "ord_kitchen",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "food" }), line({ id: "drink", type: "drinks" })],
  }
  const dependencies = fakeDependencies(order)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor,
  }, dependencies)
  assert.equal(order.items[0].fulfillmentStatus, "in_progress")
  assert.equal(order.items[1].fulfillmentStatus, "pending")
  assert.equal(order.status, "in_progress")
  const startedAt = order.items[0].fulfillmentStartedAt

  const replay = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor,
  }, dependencies)
  assert.equal(replay.changed, false)
  assert.equal(order.items[0].fulfillmentStartedAt, startedAt)

  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "ready", actor,
  }, dependencies)
  assert.equal(order.items[0].fulfillmentStatus, "ready")
  assert.equal(order.items[1].fulfillmentStatus, "pending")
  assert.equal(order.status, "in_progress")
})

test("pure Kitchen order follows pending to in_progress to ready", async () => {
  const order = {
    orderId: "ord_kitchen_only",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "food" })],
  }
  const dependencies = fakeDependencies(order)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor,
  }, dependencies)
  assert.equal(order.status, "in_progress")
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "ready", actor,
  }, dependencies)
  assert.equal(order.status, "ready")
})

test("Bar direct and prepared lines follow distinct legal transitions", async () => {
  const order = {
    orderId: "ord_bar",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [
      line({ id: "direct", type: "drinks" }),
      line({ id: "prepared", type: "drinks", behavior: "prepared" }),
    ],
  }
  const dependencies = fakeDependencies(order)
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "bar", action: "start",
      orderLineIds: ["direct"], actor: barActor,
    }, dependencies),
    { code: "DIRECT_ITEM_CANNOT_START" },
  )
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready",
      orderLineIds: ["prepared"], actor: barActor,
    }, dependencies),
    { code: "PREPARED_ITEM_NOT_STARTED" },
  )

  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready",
    orderLineIds: ["direct"], actor: barActor,
  }, dependencies)
  assert.equal(order.items[0].fulfillmentStatus, "ready")
  assert.equal(order.items[0].fulfillmentStartedAt, null)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "start",
    orderLineIds: ["prepared"], actor: barActor,
  }, dependencies)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready",
    orderLineIds: ["prepared"], actor: barActor,
  }, dependencies)
  assert.equal(order.status, "ready")
})

test("mixed Bar exposes prepared ETA before a pending direct line is ready", async () => {
  const startedAt = new Date("2026-09-04T12:00:00.000Z")
  const expectedReadyAt = new Date("2026-09-04T12:04:00.000Z")
  const order = {
    orderId: "ord_bar_mixed_eta",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [
      line({ id: "sprite", type: "drinks", behavior: "direct" }),
      line({ id: "negroni", type: "drinks", behavior: "prepared", prepTimeMinutes: 4 }),
    ],
  }
  const dependencies = fakeDependencies(order, startedAt)

  await transitionOrderFulfillment({
    businessId: "biz_a",
    orderId: order.orderId,
    station: "bar",
    action: "start",
    orderLineIds: ["negroni"],
    actor: barActor,
  }, dependencies)

  assert.equal(order.items[0].fulfillmentStatus, "pending")
  assert.equal(order.items[1].fulfillmentStatus, "in_progress")
  assert.equal(order.items[1].fulfillmentStartedAt, startedAt)
  assert.equal(order.status, "in_progress")

  const beforeDirectReady = getCustomerOrderProgress(order)
  assert.equal(beforeDirectReady.stationContext.drinks.state, "preparing")
  assert.equal(beforeDirectReady.stationContext.drinks.estimatedReadyAt.toISOString(), expectedReadyAt.toISOString())
  assert.equal(beforeDirectReady.etaMode, "overall")
  assert.equal(beforeDirectReady.estimatedReadyAt.toISOString(), expectedReadyAt.toISOString())
  assert.equal(
    toOrderDTO(order).customerProgress.estimatedReadyAt.toISOString(),
    expectedReadyAt.toISOString(),
  )

  await transitionOrderFulfillment({
    businessId: "biz_a",
    orderId: order.orderId,
    station: "bar",
    action: "ready",
    orderLineIds: ["sprite"],
    actor: barActor,
  }, dependencies)

  const afterDirectReady = getCustomerOrderProgress(order)
  assert.equal(order.items[0].fulfillmentStatus, "ready")
  assert.equal(order.items[1].fulfillmentStatus, "in_progress")
  assert.equal(order.status, "in_progress")
  assert.equal(afterDirectReady.etaMode, "overall")
  assert.equal(afterDirectReady.estimatedReadyAt.toISOString(), expectedReadyAt.toISOString())
})

test("pure Bar prepared follows pending to in_progress to ready", async () => {
  const order = {
    orderId: "ord_bar_prepared",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "prepared", type: "drinks", behavior: "prepared" })],
  }
  const dependencies = fakeDependencies(order)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "start", actor: barActor,
  }, dependencies)
  assert.equal(order.status, "in_progress")
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.equal(order.status, "ready")
})

test("pure Bar direct follows pending to ready and duplicate ready is idempotent", async () => {
  const order = {
    orderId: "ord_bar_direct",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "direct", type: "drinks" })],
  }
  const dependencies = fakeDependencies(order)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.equal(order.status, "ready")
  assert.equal(order.items[0].fulfillmentStartedAt, null)
  const readyAt = order.items[0].fulfillmentReadyAt
  const replay = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.equal(replay.changed, false)
  assert.equal(order.items[0].fulfillmentReadyAt, readyAt)
})

test("station ownership, tenancy, and terminal states are enforced", async () => {
  const order = {
    orderId: "ord_scope",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "food" }), line({ id: "drink", type: "drinks" })],
  }
  const dependencies = fakeDependencies(order)
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start",
      orderLineIds: ["drink"], actor,
    }, dependencies),
    { code: "CROSS_STATION_FULFILLMENT_FORBIDDEN" },
  )
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready",
      orderLineIds: ["food"], actor: barActor,
    }, dependencies),
    { code: "CROSS_STATION_FULFILLMENT_FORBIDDEN" },
  )
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_b", orderId: order.orderId, station: "kitchen", action: "start", actor,
    }, dependencies),
    { code: "ORDER_NOT_FOUND" },
  )
  order.status = "cancelled"
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor,
    }, dependencies),
    { code: "ORDER_FULFILLMENT_TERMINAL" },
  )
})

test("station and handoff mutations reject unauthorized staff roles", async () => {
  const order = {
    orderId: "ord_roles",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [line({ id: "food" }), line({ id: "drink", type: "drinks" })],
  }
  const dependencies = fakeDependencies(order)

  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor,
    }, dependencies),
    { code: "FULFILLMENT_ROLE_FORBIDDEN" },
  )
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor: barActor,
    }, dependencies),
    { code: "FULFILLMENT_ROLE_FORBIDDEN" },
  )
  await assert.rejects(
    completeOrderForWaitstaff({ businessId: "biz_a", orderId: order.orderId, actor }, dependencies),
    { code: "HANDOFF_ROLE_FORBIDDEN" },
  )
})

test("waitstaff alone performs final handoff after every line is ready and payment is valid", async () => {
  const order = {
    orderId: "ord_serve",
    businessId: "biz_a",
    status: "in_progress",
    paymentChannel: "offline",
    paymentStatus: "paid",
    items: [line({ status: "ready" }), line({ type: "drinks", status: "pending" })],
  }
  const dependencies = fakeDependencies(order)
  await assert.rejects(
    completeOrderForWaitstaff({ businessId: "biz_a", orderId: order.orderId, actor: waiterActor }, dependencies),
    { code: "ORDER_NOT_READY_TO_SERVE" },
  )
  order.items[1].fulfillmentStatus = "ready"
  const completed = await completeOrderForWaitstaff({
    businessId: "biz_a", orderId: order.orderId, actor: waiterActor,
  }, dependencies)
  assert.equal(completed.order.status, "completed")
  assert.equal(completed.order.servedByStaffId, "staff_1")
  assert.equal(completed.order.completedBy, "Alex")
  const replay = await completeOrderForWaitstaff({
    businessId: "biz_a", orderId: order.orderId, actor: waiterActor,
  }, dependencies)
  assert.equal(replay.replayed, true)
})

test("customer projection is deterministic and hides internal fulfilment terminology", () => {
  const mixed = {
    orderId: "ord_customer",
    businessId: "biz_a",
    servicePointLabel: "sp_1",
    status: "in_progress",
    items: [
      line({ status: "in_progress" }),
      line({ type: "drinks", status: "ready" }),
    ],
  }
  assert.equal(
    getCustomerOrderStatusMessage(mixed, { now: PROJECTION_NOW }),
    "Your drinks are ready. Your food is still being prepared.",
  )
  const customerDTO = toOrderDTO(mixed, { customerProgressOptions: { now: PROJECTION_NOW } })
  assert.equal(customerDTO.customerStatusMessage, "Your drinks are ready. Your food is still being prepared.")
  assert.equal("fulfillmentStatus" in customerDTO.items[0], false)
  assert.equal("orderLineId" in customerDTO.items[0], false)
  const staffDTO = toOrderDTO(mixed, { includeFulfillment: true })
  assert.equal(staffDTO.items[0].fulfillmentStation, "kitchen")
})

test("customer messages cover placed, partial readiness, all-ready, and pure-station orders", () => {
  const scenarios = [
    {
      status: "placed",
      items: [line(), line({ type: "drinks" })],
      expected: "Your order is confirmed.",
    },
    {
      status: "in_progress",
      items: [line({ status: "in_progress" }), line({ type: "drinks" })],
      expected: "Your food is being prepared.",
    },
    {
      status: "in_progress",
      items: [line({ status: "ready" }), line({ type: "drinks", behavior: "prepared", status: "in_progress" })],
      expected: "Your food is ready. Your drinks are still being prepared.",
    },
    {
      status: "ready",
      items: [line({ status: "ready" }), line({ type: "drinks", status: "ready" })],
      expected: "Your order is ready to be served.",
    },
    {
      status: "in_progress",
      items: [line({ status: "in_progress" })],
      expected: "Your food is being prepared.",
    },
    {
      status: "in_progress",
      items: [
        line({ id: "sprite", type: "drinks", status: "ready" }),
        line({ id: "mojito", type: "drinks", behavior: "prepared", status: "in_progress" }),
      ],
      expected: "Your drinks are being prepared.",
    },
  ]
  for (const scenario of scenarios) {
    assert.equal(getCustomerOrderStatusMessage(scenario, { now: PROJECTION_NOW }), scenario.expected)
  }
})

test("placed customer projection uses only frozen fulfilment composition", () => {
  const scenarios = [
    {
      name: "food only",
      items: [line()],
      secondaryMessage: "Waiting for the kitchen to start preparing your food.",
    },
    {
      name: "prepared drinks only",
      items: [line({ type: "drinks", behavior: "prepared" })],
      secondaryMessage: "Waiting for the bar to start preparing your drinks.",
    },
    {
      name: "direct drinks only",
      items: [line({ type: "drinks", behavior: "direct" })],
      secondaryMessage: "Waiting for the bar to get your drinks ready.",
    },
    {
      name: "food and prepared drinks",
      items: [line(), line({ type: "drinks", behavior: "prepared" })],
      secondaryMessage: "Waiting for the kitchen and bar to begin preparation.",
    },
    {
      name: "food and direct drinks",
      items: [line(), line({ type: "drinks", behavior: "direct" })],
      secondaryMessage: "Waiting for preparation to begin.",
    },
    {
      name: "prepared and direct drinks",
      items: [
        line({ type: "drinks", behavior: "prepared" }),
        line({ type: "drinks", behavior: "direct" }),
      ],
      secondaryMessage: "Waiting for the bar to get started.",
    },
  ]

  for (const scenario of scenarios) {
    const order = { status: "placed", items: scenario.items }
    const projection = getCustomerOrderProgress(order)
    assert.equal(projection.globalStatus, "placed", scenario.name)
    assert.equal(projection.headline, "Your order is confirmed.", scenario.name)
    assert.equal(projection.secondaryMessage, scenario.secondaryMessage, scenario.name)
    assert.equal(projection.etaMode, "none", scenario.name)
    assert.equal(order.status, "placed", scenario.name)
  }

  const directOnly = getCustomerOrderProgress({
    status: "placed",
    items: [line({ type: "drinks", behavior: "direct" })],
  })
  assert.doesNotMatch(directOnly.secondaryMessage, /prepar/i)
})

test("placed customer projection falls back safely for incomplete or inconsistent snapshots", () => {
  const incomplete = getCustomerOrderProgress({
    status: "placed",
    items: [{ itemName: "Legacy drink", type: "drinks" }],
  })
  const inconsistent = getCustomerOrderProgress({
    status: "placed",
    items: [line({ status: "in_progress" })],
  })

  for (const projection of [incomplete, inconsistent]) {
    assert.equal(projection.headline, "Your order is confirmed.")
    assert.equal(projection.secondaryMessage, "Waiting for preparation to begin.")
    assert.equal(projection.etaMode, "none")
  }

  const legacyDTO = toOrderDTO({
    status: "placed",
    items: [{ itemName: "Legacy drink", quantity: 1, lineTotal: 4, type: "drinks" }],
  })
  assert.equal(legacyDTO.customerProgress.secondaryMessage, "Waiting for preparation to begin.")
})

test("online and offline placed orders produce identical waiting projections", () => {
  const items = [line(), line({ type: "drinks", behavior: "prepared" })]
  const offline = getCustomerOrderProgress({ status: "placed", paymentChannel: "offline", items })
  const online = getCustomerOrderProgress({ status: "placed", paymentChannel: "online", items })
  assert.deepEqual(online, offline)
})

test("waiting-for-start assistance covers prepared, direct, mixed, payment, and threshold cases", () => {
  const createdAt = new Date("2026-09-04T12:00:00.000Z")
  const belowThreshold = new Date("2026-09-04T12:09:59.999Z")
  const beyondThreshold = new Date("2026-09-04T12:10:00.000Z")
  const food = line({ id: "food_waiting" })
  const preparedDrink = line({
    id: "drink_waiting",
    type: "drinks",
    behavior: "prepared",
  })

  const foodBelow = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [food] },
    { now: belowThreshold },
  )
  assert.equal(foodBelow.assistanceAvailable, false)
  assert.equal(foodBelow.assistanceAvailableAt.toISOString(), "2026-09-04T12:10:00.000Z")

  const foodBeyond = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [food] },
    { now: beyondThreshold },
  )
  assert.equal(foodBeyond.assistanceAvailable, true)
  assert.deepEqual(foodBeyond.assistanceStations, ["kitchen"])

  const barBelow = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [preparedDrink] },
    { now: belowThreshold },
  )
  const barBeyond = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [preparedDrink] },
    { now: beyondThreshold },
  )
  assert.equal(barBelow.assistanceAvailable, false)
  assert.equal(barBeyond.assistanceAvailable, true)
  assert.deepEqual(barBeyond.assistanceStations, ["bar"])

  const directOnly = getCustomerOrderProgress(
    {
      status: "placed",
      createdAt,
      items: [line({ type: "drinks", behavior: "direct" })],
    },
    { now: beyondThreshold },
  )
  assert.equal(directOnly.assistanceAvailable, false)
  assert.equal(directOnly.assistanceAvailableAt, null)

  const startedBar = line({
    type: "drinks",
    behavior: "prepared",
    status: "in_progress",
    startedAt: new Date("2026-09-04T12:02:00.000Z"),
  })
  const barStartedFirst = getCustomerOrderProgress(
    { status: "in_progress", createdAt, items: [food, startedBar] },
    { now: beyondThreshold },
  )
  assert.equal(barStartedFirst.assistanceAvailable, true)
  assert.deepEqual(barStartedFirst.assistanceStations, ["kitchen"])

  const startedFood = line({
    status: "in_progress",
    startedAt: new Date("2026-09-04T12:02:00.000Z"),
  })
  const kitchenStartedFirst = getCustomerOrderProgress(
    { status: "in_progress", createdAt, items: [startedFood, preparedDrink] },
    { now: beyondThreshold },
  )
  assert.equal(kitchenStartedFirst.assistanceAvailable, true)
  assert.deepEqual(kitchenStartedFirst.assistanceStations, ["bar"])

  const allStarted = getCustomerOrderProgress(
    { status: "in_progress", createdAt, items: [startedFood, startedBar] },
    { now: beyondThreshold },
  )
  assert.equal(allStarted.assistanceAvailable, false)

  const offline = getCustomerOrderProgress(
    { status: "placed", paymentChannel: "offline", createdAt, items: [food] },
    { now: beyondThreshold },
  )
  const online = getCustomerOrderProgress(
    { status: "placed", paymentChannel: "online", createdAt, items: [food] },
    { now: beyondThreshold },
  )
  assert.deepEqual(online, offline)

  const customBelow = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [food] },
    { now: new Date("2026-09-04T12:19:59.999Z"), orderStartAssistanceDelayMinutes: 20 },
  )
  const customBeyond = getCustomerOrderProgress(
    { status: "placed", createdAt, items: [food] },
    { now: new Date("2026-09-04T12:20:00.000Z"), orderStartAssistanceDelayMinutes: 20 },
  )
  assert.equal(customBelow.assistanceAvailable, false)
  assert.equal(customBeyond.assistanceAvailable, true)
  assert.equal(
    customBeyond.assistanceAvailableAt.toISOString(),
    "2026-09-04T12:20:00.000Z",
  )

  assert.equal(DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES, 10)
  const orderingPreferencesPath = Business.schema.path(
    "orderingPreferences.orderStartAssistanceDelayMinutes",
  )
  assert.equal(orderingPreferencesPath.defaultValue, 10)
  assert.equal(orderingPreferencesPath.options.min, 1)
  assert.equal(orderingPreferencesPath.options.max, 240)
})

test("waiting assistance is disabled for incomplete snapshots or disabled waiter calls", () => {
  const order = {
    status: "placed",
    createdAt: new Date("2026-09-04T12:00:00.000Z"),
    items: [{ itemName: "Legacy food", type: "food" }],
  }
  const legacy = getCustomerOrderProgress(order, {
    now: new Date("2026-09-04T13:00:00.000Z"),
  })
  assert.equal(legacy.assistanceAvailable, false)
  assert.equal(legacy.assistanceReason, null)

  const disabled = getCustomerOrderProgress({
    ...order,
    items: [line()],
  }, {
    assistanceEnabled: false,
    now: new Date("2026-09-04T13:00:00.000Z"),
  })
  assert.equal(disabled.assistanceAvailable, false)
  assert.equal(disabled.assistanceAvailableAt, null)
})

test("customer progress projection covers station starts, partial readiness, and waiting context", () => {
  const scenarios = [
    {
      name: "Bar starts first",
      order: {
        status: "in_progress",
        items: [
          line({ id: "food_pending" }),
          line({ id: "drink_active", type: "drinks", behavior: "prepared", status: "in_progress", prepTimeMinutes: 4 }),
        ],
      },
      headline: "Your drinks are being prepared.",
      secondary: "Waiting for the kitchen to start your food.",
    },
    {
      name: "Kitchen starts first",
      order: {
        status: "in_progress",
        items: [
          line({ id: "food_active", status: "in_progress" }),
          line({ id: "drink_pending", type: "drinks", behavior: "prepared" }),
        ],
      },
      headline: "Your food is being prepared.",
      secondary: "Waiting for the bar to start your drinks.",
    },
    {
      name: "both stations prepare",
      order: {
        status: "in_progress",
        items: [
          line({ status: "in_progress" }),
          line({ type: "drinks", behavior: "prepared", status: "in_progress" }),
        ],
      },
      headline: "Your food and drinks are being prepared.",
      secondary: null,
    },
    {
      name: "Bar ready first",
      order: {
        status: "in_progress",
        items: [
          line({ status: "in_progress" }),
          line({ type: "drinks", status: "ready" }),
        ],
      },
      headline: "Your drinks are ready. Your food is still being prepared.",
      secondary: null,
    },
    {
      name: "Kitchen ready first",
      order: {
        status: "in_progress",
        items: [
          line({ status: "ready" }),
          line({ type: "drinks", behavior: "prepared", status: "in_progress" }),
        ],
      },
      headline: "Your food is ready. Your drinks are still being prepared.",
      secondary: null,
    },
    {
      name: "direct Bar ready before Kitchen starts",
      order: {
        status: "in_progress",
        items: [
          line({ status: "pending" }),
          line({ type: "drinks", behavior: "direct", status: "ready" }),
        ],
      },
      headline: "Your drinks are ready.",
      secondary: "Waiting for the kitchen to start your food.",
    },
  ]

  for (const scenario of scenarios) {
    const projection = getCustomerOrderProgress(scenario.order, { now: PROJECTION_NOW })
    assert.equal(projection.globalStatus, "in_progress", scenario.name)
    assert.equal(projection.headline, scenario.headline, scenario.name)
    assert.equal(projection.secondaryMessage, scenario.secondary, scenario.name)
    assert.doesNotMatch(`${projection.headline} ${projection.secondaryMessage || ""}`, /pending/i)
  }
})

test("customer ETA uses station starts and the latest required completion estimate", () => {
  const startedAt = new Date("2026-09-04T20:19:00.000Z")
  const pendingKitchen = line({ id: "food_pending", prepTimeMinutes: 10 })
  const activeKitchen = line({
    id: "food_active",
    status: "in_progress",
    prepTimeMinutes: 10,
    startedAt,
  })
  const activeBar = line({
    id: "drink_active",
    type: "drinks",
    behavior: "prepared",
    status: "in_progress",
    prepTimeMinutes: 4,
    startedAt,
  })

  const oneStationStarted = getCustomerOrderProgress({
    status: "in_progress",
    items: [pendingKitchen, activeBar],
  })
  assert.equal(oneStationStarted.etaMode, "station")
  assert.equal(oneStationStarted.estimatedReadyAt, null)
  assert.equal(
    oneStationStarted.stationContext.drinks.estimatedReadyAt.toISOString(),
    "2026-09-04T20:23:00.000Z",
  )

  const bothStarted = getCustomerOrderProgress({
    status: "in_progress",
    items: [activeKitchen, activeBar],
  })
  assert.equal(bothStarted.etaMode, "overall")
  assert.equal(bothStarted.estimatedReadyAt.toISOString(), "2026-09-04T20:29:00.000Z")

  const pureKitchen = getCustomerOrderProgress({ status: "in_progress", items: [activeKitchen] })
  assert.equal(pureKitchen.etaMode, "overall")
  assert.equal(pureKitchen.estimatedReadyAt.toISOString(), "2026-09-04T20:29:00.000Z")

  const purePreparedBar = getCustomerOrderProgress({ status: "in_progress", items: [activeBar] })
  assert.equal(purePreparedBar.etaMode, "overall")
  assert.equal(purePreparedBar.estimatedReadyAt.toISOString(), "2026-09-04T20:23:00.000Z")

  const pureDirectBar = getCustomerOrderProgress({
    status: "placed",
    items: [line({ type: "drinks", behavior: "direct", status: "pending" })],
  })
  assert.equal(pureDirectBar.etaMode, "none")
  assert.equal(pureDirectBar.estimatedReadyAt, null)

  const preparedReadyDirectPending = getCustomerOrderProgress({
    status: "in_progress",
    items: [
      line({ type: "drinks", behavior: "prepared", status: "ready" }),
      line({ type: "drinks", behavior: "direct", status: "pending" }),
    ],
  })
  assert.equal(preparedReadyDirectPending.stationContext.drinks.state, "waiting")
  assert.equal(preparedReadyDirectPending.etaMode, "none")
  assert.equal(preparedReadyDirectPending.estimatedReadyAt, null)

  const bothBarLinesReady = getCustomerOrderProgress({
    status: "ready",
    items: [
      line({ type: "drinks", behavior: "prepared", status: "ready" }),
      line({ type: "drinks", behavior: "direct", status: "ready" }),
    ],
  })
  assert.equal(bothBarLinesReady.stationContext.drinks.state, "ready")
  assert.equal(bothBarLinesReady.etaMode, "none")
  assert.equal(bothBarLinesReady.estimatedReadyAt, null)

  const laterPreparedStart = new Date("2026-09-04T20:20:00.000Z")
  const multiplePreparedBar = getCustomerOrderProgress({
    status: "in_progress",
    items: [
      activeBar,
      line({
        type: "drinks",
        behavior: "prepared",
        status: "in_progress",
        prepTimeMinutes: 7,
        startedAt: laterPreparedStart,
      }),
    ],
  })
  assert.equal(multiplePreparedBar.etaMode, "overall")
  assert.equal(multiplePreparedBar.estimatedReadyAt.toISOString(), "2026-09-04T20:27:00.000Z")
})

test("elapsed preparation ETA projects calm food, drinks, mixed, and ready states", () => {
  const startedAt = new Date("2026-09-04T12:00:00.000Z")
  const beforeEta = new Date("2026-09-04T12:09:59.999Z")
  const atEta = new Date("2026-09-04T12:10:00.000Z")
  const activeFood = line({ status: "in_progress", prepTimeMinutes: 10, startedAt })
  const activeDrink = line({
    type: "drinks",
    behavior: "prepared",
    status: "in_progress",
    prepTimeMinutes: 10,
    startedAt,
  })

  const active = getCustomerOrderProgress(
    { status: "in_progress", items: [activeFood] },
    { now: beforeEta },
  )
  assert.equal(active.etaState, "active")
  assert.equal(active.headline, "Your food is being prepared.")

  const foodExtended = getCustomerOrderProgress(
    { status: "in_progress", items: [activeFood] },
    { now: atEta },
  )
  assert.equal(foodExtended.etaState, "extended")
  assert.equal(foodExtended.headline, "Still being prepared")
  assert.equal(foodExtended.secondaryMessage, "Your food is still being prepared.")

  const drinksExtended = getCustomerOrderProgress(
    { status: "in_progress", items: [activeDrink] },
    { now: atEta },
  )
  assert.equal(drinksExtended.headline, "Still being prepared")
  assert.equal(drinksExtended.secondaryMessage, "Your drinks are still being prepared.")

  const mixedExtended = getCustomerOrderProgress(
    { status: "in_progress", items: [activeFood, activeDrink] },
    { now: atEta },
  )
  assert.equal(mixedExtended.headline, "Still being prepared")
  assert.equal(
    mixedExtended.secondaryMessage,
    "Your food and drinks are still being prepared.",
  )

  const ready = getCustomerOrderProgress({
    status: "ready",
    items: [
      line({ status: "ready" }),
      line({ type: "drinks", behavior: "prepared", status: "ready" }),
    ],
  }, { now: atEta })
  assert.equal(ready.headline, "Your order is ready to be served.")
  assert.equal(ready.etaState, "none")
  assert.equal(ready.assistanceAvailable, false)
})

test("offline and Stripe orders produce identical customer progress projections", () => {
  const items = [
    line({ status: "in_progress", prepTimeMinutes: 9 }),
    line({ type: "drinks", behavior: "prepared", status: "in_progress", prepTimeMinutes: 4 }),
    line({ type: "drinks", behavior: "direct", status: "pending" }),
  ]
  const offline = getCustomerOrderProgress({ status: "in_progress", paymentChannel: "offline", items })
  const online = getCustomerOrderProgress({ status: "in_progress", paymentChannel: "online", items })
  assert.deepEqual(online, offline)
  assert.equal(online.etaMode, "overall")
})

test("customer fulfilment notifications are transition-specific, final-ready deduped, and idempotent", async () => {
  const order = {
    orderId: "ord_customer_events",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    items: [
      line({ id: "food_event", prepTimeMinutes: 10 }),
      line({ id: "drink_event", type: "drinks", behavior: "prepared", prepTimeMinutes: 4 }),
    ],
  }
  const dependencies = fakeDependencies(order)

  const barStarted = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "start", actor: barActor,
  }, dependencies)
  assert.deepEqual(barStarted.customerNotification, {
    eventId: "ord_customer_events:BAR_STARTED",
    eventType: "BAR_STARTED",
    title: "Drinks are being prepared",
    message: "We've started preparing your drinks.",
  })

  const duplicateBarStart = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "start", actor: barActor,
  }, dependencies)
  assert.equal(duplicateBarStart.changed, false)
  assert.equal(duplicateBarStart.customerNotification, null)

  const kitchenStarted = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "start", actor,
  }, dependencies)
  assert.equal(kitchenStarted.customerNotification.eventType, "KITCHEN_STARTED")
  assert.equal(kitchenStarted.customerNotification.message, "We've started preparing your food.")

  const barReady = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.equal(barReady.order.status, "in_progress")
  assert.equal(barReady.customerNotification.eventType, "BAR_READY")
  assert.equal(barReady.customerNotification.message, "Your drinks are ready.")

  const orderReady = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "kitchen", action: "ready", actor,
  }, dependencies)
  assert.equal(orderReady.order.status, "ready")
  assert.equal(orderReady.customerNotification.eventType, "ORDER_READY")
  assert.equal(orderReady.customerNotification.message, "Your order is ready to be served.")
  assert.notEqual(orderReady.customerNotification.eventType, "KITCHEN_READY")
})

test("direct drinks never emit a preparation notification and served notification replays are silent", async () => {
  const order = {
    orderId: "ord_direct_event",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "offline",
    paymentStatus: "paid",
    items: [line({ id: "direct_event", type: "drinks", behavior: "direct" })],
  }
  const dependencies = fakeDependencies(order)
  const ready = await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.equal(ready.customerNotification.eventType, "ORDER_READY")
  assert.notEqual(ready.customerNotification.eventType, "BAR_STARTED")

  const served = await completeOrderForWaitstaff({
    businessId: "biz_a", orderId: order.orderId, actor: waiterActor,
  }, dependencies)
  assert.equal(served.customerNotification.eventType, "ORDER_SERVED")
  const replay = await completeOrderForWaitstaff({
    businessId: "biz_a", orderId: order.orderId, actor: waiterActor,
  }, dependencies)
  assert.equal(replay.changed, false)
  assert.equal(replay.customerNotification, null)
})

test("station routes expose only station actions and retain canonical role guards", async () => {
  const kitchenRoute = fs.readFileSync(new URL("../src/routes/kitchen-route.js", import.meta.url), "utf8")
  const barRoute = fs.readFileSync(new URL("../src/routes/bar-route.js", import.meta.url), "utf8")
  const orderRoute = fs.readFileSync(new URL("../src/routes/order-route.js", import.meta.url), "utf8")
  assert.match(kitchenRoute, /requireRole\("kitchen"\)/)
  assert.match(kitchenRoute, /\/orders\/:orderId\/fulfillment/)
  assert.doesNotMatch(kitchenRoute, /enum: \[placed, in_progress, ready, completed\]/)
  assert.match(barRoute, /requireRole\("bartender", "manager", "owner", "co_owner", "admin"\)/)
  assert.match(barRoute, /PERMISSIONS\.ORDERS_MANAGE/)
  assert.match(orderRoute, /requireRole\("waiter", "manager", "owner", "co_owner"\)/)
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: "ord", station: "kitchen", action: "completed", actor,
    }),
    { code: "INVALID_FULFILLMENT_ACTION" },
  )
  await assert.rejects(
    transitionOrderFulfillment({
      businessId: "biz_a", orderId: "ord", station: "bar", action: "completed", actor: barActor,
    }),
    { code: "INVALID_FULFILLMENT_ACTION" },
  )
})

test("realtime publication carries customer transition events and skips idempotent retries", () => {
  const kitchenController = fs.readFileSync(
    new URL("../src/controllers/kitchenController.js", import.meta.url),
    "utf8",
  )
  const barController = fs.readFileSync(
    new URL("../src/controllers/barController.js", import.meta.url),
    "utf8",
  )
  const orderController = fs.readFileSync(
    new URL("../src/controllers/orderController.js", import.meta.url),
    "utf8",
  )
  const realtimeService = fs.readFileSync(
    new URL("../src/services/orderRealtimeService.js", import.meta.url),
    "utf8",
  )
  const sseManager = fs.readFileSync(
    new URL("../src/utils/sseManager.js", import.meta.url),
    "utf8",
  )
  const realtimeBus = fs.readFileSync(
    new URL("../src/utils/realtimeBus.js", import.meta.url),
    "utf8",
  )

  for (const controller of [kitchenController, barController]) {
    assert.match(controller, /if \(result\.changed\)/)
    assert.match(controller, /customerNotification: result\.customerNotification/)
    assert.match(controller, /order: toStationOrderDTO\(result\.order,/)
  }
  assert.match(orderController, /if \(completion\.changed\)/)
  assert.match(orderController, /customerNotification: completion\.customerNotification/)
  assert.match(realtimeService, /customerNotification/)
  assert.match(realtimeService, /\["waiter", "table", "anon"\]/)
  assert.match(sseManager, /originInstanceId: REALTIME_INSTANCE_ID/)
  assert.match(sseManager, /await broadcastLocal\(msg\)[\s\S]*if \(!redisPub\)/)
  assert.match(realtimeBus, /msg\.originInstanceId === REALTIME_INSTANCE_ID/)
})

test("legacy order lines materialize from frozen order type without reading MenuItem", async () => {
  const order = {
    orderId: "ord_legacy",
    businessId: "biz_a",
    status: "placed",
    paymentChannel: "online",
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
    items: [{ itemName: "Legacy Drink", quantity: 2, lineTotal: 6, type: "drinks" }],
  }
  const dependencies = fakeDependencies(order)
  await transitionOrderFulfillment({
    businessId: "biz_a", orderId: order.orderId, station: "bar", action: "ready", actor: barActor,
  }, dependencies)
  assert.match(order.items[0].orderLineId, /^oln_/)
  assert.equal(order.items[0].fulfillmentBehavior, "direct")
  assert.equal(order.items[0].fulfillmentStatus, "ready")
  assert.equal(order.status, "ready")
})
