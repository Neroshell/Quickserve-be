import assert from "node:assert/strict"
import test, { after } from "node:test"

import { redisPub, redisSub } from "../src/config/redisClient.js"
import Business from "../src/models/Business.js"
import GuestSession from "../src/models/GuestSession.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import ServicePoint from "../src/models/ServicePoint.js"
import {
  getOrderById,
  listCurrentOrders,
  listOrders,
} from "../src/controllers/orderController.js"
import { reorderFromOrder } from "../src/controllers/reorderController.js"
import { broadcastLocal, sseHandler } from "../src/utils/sseManager.js"

after(() => {
  redisPub?.disconnect()
  redisSub?.disconnect()
})

const future = () => new Date(Date.now() + 60_000)

function request({
  businessId = "business-a",
  sessionId = "device-a",
  token,
  orderId,
  scope,
  servicePointId,
} = {}) {
  const headers = token ? { "x-table-session-token": token } : {}
  return {
    body: {
      businessId,
      sessionId,
      tableSessionToken: token,
      servicePointId,
    },
    headers,
    params: orderId ? { orderId } : {},
    query: { businessId, sessionId, scope },
    session: {},
    get(name) {
      return headers[name.toLowerCase()]
    },
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    end(body) {
      this.body = body
      this.ended = true
      return this
    },
  }
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$gt" in value) {
      return new Date(record[key]).getTime() > new Date(value.$gt).getTime()
    }
    return String(record[key]) === String(value)
  })
}

test("historical history and current live visit remain separate authorization scopes", async (t) => {
  const visits = [
    {
      _id: "guest_visit_a",
      token: "token-a",
      businessId: "business-a",
      servicePointId: "sp-x",
      boundSessionId: "device-a",
      expiresAt: new Date(Date.now() - 60_000),
    },
    {
      _id: "guest_visit_b",
      token: "token-b",
      businessId: "business-a",
      servicePointId: "sp-x",
      boundSessionId: "device-a",
      expiresAt: future(),
    },
    {
      _id: "guest_visit_c",
      token: "token-c",
      businessId: "business-a",
      servicePointId: "sp-y",
      boundSessionId: "device-a",
      expiresAt: future(),
    },
    {
      _id: "guest_visit_wrong_device",
      token: "token-wrong-device",
      businessId: "business-a",
      servicePointId: "sp-x",
      boundSessionId: "device-b",
      expiresAt: future(),
    },
    {
      _id: "guest_visit_business_b",
      token: "token-business-b",
      businessId: "business-b",
      servicePointId: "sp-x",
      boundSessionId: "device-a",
      expiresAt: future(),
    },
  ]

  const orders = [
    {
      orderId: "order-visit-a",
      businessId: "business-a",
      servicePointId: "sp-x",
      displayLabel: "Table X",
      guestSessionId: "guest_visit_a",
      sessionId: "device-a",
      status: "ready",
      items: [{ itemName: "Old Dish", quantity: 1, lineTotal: 8 }],
      total: 8,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    },
    {
      orderId: "order-visit-b",
      businessId: "business-a",
      servicePointId: "sp-x",
      displayLabel: "Table X",
      guestSessionId: "guest_visit_b",
      sessionId: "device-a",
      status: "placed",
      items: [{ itemName: "Current Dish", quantity: 1, lineTotal: 12 }],
      total: 12,
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
    },
    {
      orderId: "order-visit-c",
      businessId: "business-a",
      servicePointId: "sp-y",
      displayLabel: "Table Y",
      guestSessionId: "guest_visit_c",
      sessionId: "device-a",
      status: "placed",
      items: [{ itemName: "Other Table Dish", quantity: 1, lineTotal: 10 }],
      total: 10,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
    },
    {
      orderId: "legacy-history-only",
      businessId: "business-a",
      servicePointId: "sp-x",
      displayLabel: "Table X",
      sessionId: "device-a",
      status: "completed",
      items: [],
      total: 5,
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    },
    {
      orderId: "business-b-history",
      businessId: "business-b",
      servicePointLabel: "sp-x",
      guestSessionId: "guest_visit_business_b",
      sessionId: "device-a",
      status: "completed",
      items: [],
      total: 20,
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
    },
  ]

  const originalOrders = structuredClone(orders)
  const originalModelMethods = {
    guestSessionFindOne: GuestSession.findOne,
    guestSessionExists: GuestSession.exists,
    businessFindOne: Business.findOne,
    orderFind: Order.find,
    orderFindOne: Order.findOne,
    servicePointFindOne: ServicePoint.findOne,
    menuItemFind: MenuItem.find,
  }

  t.after(() => {
    GuestSession.findOne = originalModelMethods.guestSessionFindOne
    GuestSession.exists = originalModelMethods.guestSessionExists
    Business.findOne = originalModelMethods.businessFindOne
    Order.find = originalModelMethods.orderFind
    Order.findOne = originalModelMethods.orderFindOne
    ServicePoint.findOne = originalModelMethods.servicePointFindOne
    MenuItem.find = originalModelMethods.menuItemFind
  })

  GuestSession.findOne = (filter) => ({
    lean: async () => visits.find((visit) => matches(visit, filter)) || null,
  })
  GuestSession.exists = async (filter) =>
    visits.some((visit) => matches(visit, filter))
  Business.findOne = (filter) => ({
    lean: async () => ({
      businessId: filter.businessId,
      businessType: "restaurant",
      modules: ["foodService"],
    }),
  })
  Order.find = (filter) => ({
    sort: () => ({
      lean: async () => orders
        .filter((order) => matches(order, filter))
        .sort((a, b) => b.createdAt - a.createdAt),
    }),
  })
  Order.findOne = (filter) => ({
    lean: async () => orders.find((order) => matches(order, filter)) || null,
  })
  ServicePoint.findOne = (filter) => ({
    lean: async () => ({
      servicePointId: filter.servicePointId,
      businessId: filter.businessId,
      label: filter.servicePointId,
    }),
  })
  MenuItem.find = () => ({
    lean: async () => [{
      _id: "menu-current",
      name: "Old Dish",
      price: 15,
      imageUrl: "",
      category: "mains",
      type: "food",
      description: "Current menu version",
      isAvailable: true,
    }],
  })

  await t.test("history shows prior, current, other-ServicePoint, and legacy orders for the same device and business", async () => {
    const res = response()
    await listOrders(request(), res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.map((order) => order.orderId), [
      "order-visit-b",
      "order-visit-c",
      "order-visit-a",
      "legacy-history-only",
    ])
  })

  await t.test("same-device history cannot cross a business boundary", async () => {
    const res = response()
    await listOrders(request({ businessId: "business-b" }), res)
    assert.deepEqual(res.body.map((order) => order.orderId), ["business-b-history"])
  })

  await t.test("an expired original visit does not erase historical visibility", async () => {
    const res = response()
    await getOrderById(request({ orderId: "order-visit-a", scope: "history" }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.orderId, "order-visit-a")
  })

  await t.test("an unrelated device has no automatic order history", async () => {
    const res = response()
    await listOrders(request({ sessionId: "unrelated-device" }), res)
    assert.deepEqual(res.body, [])
  })

  await t.test("Order Again reads history but requires and targets a valid current visit", async () => {
    const res = response()
    await reorderFromOrder(request({
      orderId: "order-visit-a",
      token: "token-c",
      servicePointId: "sp-y",
    }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.items[0].price, 15)
    assert.deepEqual(orders, originalOrders)
  })

  await t.test("Visit B current orders exclude Visit A at the same ServicePoint and legacy orders", async () => {
    const res = response()
    await listCurrentOrders(request({ token: "token-b" }), res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.map((order) => order.orderId), ["order-visit-b"])
  })

  await t.test("the same device at a different ServicePoint gets only that current visit", async () => {
    const res = response()
    await listCurrentOrders(request({ token: "token-c" }), res)
    assert.deepEqual(res.body.map((order) => order.orderId), ["order-visit-c"])
  })

  await t.test("expired, invalid, cross-business, and wrong-device visits have no live authority", async () => {
    const cases = [
      { token: "token-a", expected: 403 },
      { token: "not-a-token", expected: 403 },
      { token: "token-business-b", expected: 403 },
      { token: "token-wrong-device", expected: 403 },
    ]
    for (const testCase of cases) {
      const res = response()
      await listCurrentOrders(request(testCase), res)
      assert.equal(res.statusCode, testCase.expected)
    }
  })

  await t.test("direct live reads require exact current visit ownership", async () => {
    const oldRes = response()
    await getOrderById(request({
      orderId: "order-visit-a",
      token: "token-b",
      scope: "current",
    }), oldRes)
    assert.equal(oldRes.statusCode, 403)

    const currentRes = response()
    await getOrderById(request({
      orderId: "order-visit-b",
      token: "token-b",
      scope: "current",
    }), currentRes)
    assert.equal(currentRes.statusCode, 200)

    const knownIdWrongDevice = response()
    await getOrderById(request({
      orderId: "order-visit-b",
      token: "token-b",
      sessionId: "device-b",
      scope: "current",
    }), knownIdWrongDevice)
    assert.equal(knownIdWrongDevice.statusCode, 403)
  })

  await t.test("historical access alone cannot authorize the Order Again current action", async () => {
    const res = response()
    await reorderFromOrder(request({
      orderId: "order-visit-a",
      token: "token-a",
      servicePointId: "sp-x",
    }), res)
    assert.equal(res.statusCode, 403)
    assert.deepEqual(orders, originalOrders)
  })

  await t.test("customer SSE is isolated by visit even at the same ServicePoint", async () => {
    const writes = []
    let closeConnection = () => {}
    const req = {
      query: {
        role: "table",
        businessId: "business-a",
        token: "token-b",
        sessionId: "device-a",
      },
      session: {},
      on(event, handler) {
        if (event === "close") closeConnection = handler
      },
    }
    const res = {
      setHeader() {},
      flushHeaders() {},
      write(chunk) { writes.push(chunk) },
    }

    await sseHandler(req, res)
    try {
      const heartbeatCount = writes.length

      await broadcastLocal({
        event: "order_updated",
        businessId: "business-a",
        targets: ["table"],
        payload: {
          businessId: "business-a",
          servicePointId: "sp-x",
          guestSessionId: "guest_visit_a",
          orderId: "order-visit-a",
          order: orders[0],
        },
      })
      assert.equal(writes.length, heartbeatCount)

      await broadcastLocal({
        event: "order_updated",
        businessId: "business-a",
        targets: ["table"],
        payload: {
          businessId: "business-a",
          servicePointId: "sp-y",
          guestSessionId: "guest_visit_c",
          orderId: "order-visit-c",
          order: orders[2],
        },
      })
      assert.equal(writes.length, heartbeatCount)

      await broadcastLocal({
        event: "order_created",
        businessId: "business-a",
        targets: ["table"],
        payload: {
          businessId: "business-a",
          servicePointId: "sp-x",
          guestSessionId: "guest_visit_b",
          orderId: "order-visit-b",
          order: orders[1],
        },
      })
      assert.equal(writes.length, heartbeatCount + 1)
      assert.match(writes.at(-1), /order-visit-b/)
    } finally {
      closeConnection()
    }
  })

  await t.test("customer SSE rejects missing device binding", async () => {
    const req = {
      query: { role: "table", businessId: "business-a", token: "token-b" },
      session: {},
    }
    const res = response()
    await sseHandler(req, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.ended, true)
  })
})
