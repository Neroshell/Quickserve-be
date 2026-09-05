import assert from "node:assert/strict"
import test from "node:test"

import Business from "../src/models/Business.js"
import GuestSession from "../src/models/GuestSession.js"
import ServicePoint from "../src/models/ServicePoint.js"
import ServiceRequest from "../src/models/ServiceRequest.js"
import { getWaiterRequestCooldownMs } from "../src/config/waiterRequest.js"
import {
  claimWaiterCall,
  createOrGetActiveWaiterCall,
  createWaiterCall,
  expireStaleCalls,
  resolveWaiterCall,
} from "../src/controllers/serviceRequestController.js"

function queryResult(value) {
  return { lean: async () => value }
}

function responseRecorder() {
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

function customerRequest(overrides = {}) {
  return {
    body: {
      token: "valid-table-token",
      businessId: "spoofed-business",
      servicePointId: "spoofed-service-point",
      servicePointLabel: "Table 7",
      reason: "Delayed order",
      ...overrides,
    },
    session: {},
    header: () => "",
  }
}

function mockTrustedCustomerIdentity(t) {
  t.mock.method(GuestSession, "findOne", () => queryResult({
    _id: "guest-session-1",
    businessId: "trusted-business",
    servicePointId: "sp-trusted",
    expiresAt: new Date(Date.now() + 60_000),
  }))
}

test("server rejects waiter calls when the business setting is disabled", async (t) => {
  mockTrustedCustomerIdentity(t)
  t.mock.method(Business, "findOne", () => queryResult({
    businessId: "trusted-business",
    businessType: "restaurant",
    modules: ["foodService"],
    orderingPreferences: { callWaiterEnabled: false },
  }))

  const res = responseRecorder()
  await createWaiterCall(customerRequest(), res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, "WAITER_CALL_DISABLED")
})

test("server rejects waiter calls while the restaurant is closed", async (t) => {
  mockTrustedCustomerIdentity(t)
  const disabledDay = { enabled: false, openTime: "09:00", closeTime: "22:00" }
  t.mock.method(Business, "findOne", () => queryResult({
    businessId: "trusted-business",
    businessType: "restaurant",
    modules: ["foodService"],
    orderingPreferences: { callWaiterEnabled: true },
    operatingHours: {
      Monday: disabledDay,
      Tuesday: disabledDay,
      Wednesday: disabledDay,
      Thursday: disabledDay,
      Friday: disabledDay,
      Saturday: disabledDay,
      Sunday: disabledDay,
    },
  }))

  const res = responseRecorder()
  await createWaiterCall(customerRequest(), res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, "BUSINESS_CLOSED")
})

test("valid table token is authoritative for tenant and service-point scope", async (t) => {
  mockTrustedCustomerIdentity(t)
  t.mock.method(Business, "findOne", () => queryResult({
    businessId: "trusted-business",
    businessType: "restaurant",
    modules: ["foodService"],
    orderingPreferences: { callWaiterEnabled: true },
  }))
  t.mock.method(ServiceRequest, "updateMany", async () => ({ modifiedCount: 0 }))
  t.mock.method(ServicePoint, "findOne", (filter) => {
    assert.equal(filter.businessId, "trusted-business")
    assert.equal(filter.servicePointId, "sp-trusted")
    return queryResult({
      servicePointId: "sp-trusted",
      label: "Table 7",
      code: "table-7",
    })
  })
  t.mock.method(ServiceRequest, "findOne", () => queryResult(null))
  let persisted
  t.mock.method(ServiceRequest, "create", async (input) => {
    persisted = input
    return { _id: "request-1", ...input }
  })

  const res = responseRecorder()
  await createWaiterCall(customerRequest(), res)
  assert.equal(res.statusCode, 201)
  assert.equal(persisted.businessId, "trusted-business")
  assert.equal(persisted.servicePointId, "sp-trusted")
  assert.equal(persisted.requestCategory, "delayed_order")
  assert.equal(
    persisted.activeScopeKey,
    JSON.stringify(["trusted-business", "foodService", "sp-trusted"]),
  )
})

test("acknowledged request within its expiry window remains active for sequential duplicates", async (t) => {
  mockTrustedCustomerIdentity(t)
  t.mock.method(Business, "findOne", () => queryResult({
    businessId: "trusted-business",
    businessType: "restaurant",
    modules: ["foodService"],
    orderingPreferences: { callWaiterEnabled: true },
  }))
  t.mock.method(ServiceRequest, "updateMany", async () => ({ modifiedCount: 0 }))
  t.mock.method(ServicePoint, "findOne", () => queryResult({
    servicePointId: "sp-trusted",
    label: "Table 7",
    code: "table-7",
  }))
  const existing = {
    _id: "request-existing",
    businessId: "trusted-business",
    servicePointId: "sp-trusted",
    status: "acknowledged",
    acknowledgedAt: new Date(),
    acknowledgedExpiresAt: new Date(Date.now() + 60_000),
    pendingExpiresAt: null,
  }
  let activeFilter
  t.mock.method(ServiceRequest, "findOne", (filter) => {
    activeFilter = filter
    return queryResult(existing)
  })
  let createCalls = 0
  t.mock.method(ServiceRequest, "create", async () => {
    createCalls += 1
  })

  const res = responseRecorder()
  await createWaiterCall(customerRequest(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.call._id, existing._id)
  assert.equal(createCalls, 0)
  assert.equal(activeFilter.businessId, "trusted-business")
  assert.deepEqual(activeFilter.$and[0], { servicePointId: "sp-trusted" })
  assert.equal(activeFilter.$and[1].$or[0].status, "acknowledged")
  assert.ok(activeFilter.$and[1].$or[0].$or)
})

test("simultaneous waiter calls converge on one active persisted request", async () => {
  let activeCall = null
  let sequence = 0
  const model = {
    async create(input) {
      if (activeCall?.activeScopeKey === input.activeScopeKey) {
        const error = new Error("duplicate")
        error.code = 11000
        throw error
      }
      activeCall = { _id: `request-${++sequence}`, ...input }
      return activeCall
    },
    findOne({ activeScopeKey }) {
      return queryResult(activeCall?.activeScopeKey === activeScopeKey ? activeCall : null)
    },
  }
  const activeScopeKey = JSON.stringify(["biz", "foodService", "sp-1"])
  const attempts = await Promise.all([
    createOrGetActiveWaiterCall({
      activeScopeKey,
      callInput: { status: "pending" },
      ServiceRequestModel: model,
    }),
    createOrGetActiveWaiterCall({
      activeScopeKey,
      callInput: { status: "pending" },
      ServiceRequestModel: model,
    }),
  ])

  assert.equal(new Set(attempts.map(({ call }) => call._id)).size, 1)
  assert.deepEqual(attempts.map(({ created }) => created).sort(), [false, true])

  activeCall.activeScopeKey = null
  const future = await createOrGetActiveWaiterCall({
    activeScopeKey,
    callInput: { status: "pending" },
    ServiceRequestModel: model,
  })
  assert.equal(future.created, true)
  assert.equal(future.call._id, "request-2")
})

test("acknowledgement starts a fresh expiry window and resolution still releases its unique scope", async (t) => {
  t.mock.method(ServiceRequest, "updateMany", async () => ({ modifiedCount: 0 }))
  let claimUpdate
  t.mock.method(ServiceRequest, "findOneAndUpdate", (filter, update) => {
    claimUpdate = { filter, update }
    return queryResult({
      _id: "request-1",
      businessId: "biz-1",
      servicePointId: "sp-1",
      status: "acknowledged",
      activeScopeKey: "active-key",
      pendingExpiresAt: null,
    })
  })
  const claimRes = responseRecorder()
  await claimWaiterCall({
    params: { id: "request-1" },
    session: { user: { businessId: "biz-1", id: "waiter-1", name: "Alex" } },
  }, claimRes)
  assert.equal(claimRes.statusCode, 200)
  assert.equal(claimUpdate.filter.businessId, "biz-1")
  assert.equal(claimUpdate.update.$set.pendingExpiresAt, null)
  assert.equal(
    claimUpdate.update.$set.acknowledgedExpiresAt.getTime() -
      claimUpdate.update.$set.acknowledgedAt.getTime(),
    getWaiterRequestCooldownMs(),
  )
  assert.equal("activeScopeKey" in claimUpdate.update.$set, false)

  t.mock.restoreAll()
  t.mock.method(ServiceRequest, "updateMany", async () => ({ modifiedCount: 0 }))
  let resolveUpdate
  t.mock.method(ServiceRequest, "findOneAndUpdate", (filter, update) => {
    resolveUpdate = { filter, update }
    return queryResult({ _id: "request-1", status: "resolved" })
  })
  const resolveRes = responseRecorder()
  await resolveWaiterCall({
    params: { id: "request-1" },
    session: {
      user: {
        businessId: "biz-1",
        id: "waiter-1",
        name: "Alex",
        role: "waiter",
      },
    },
  }, resolveRes)
  assert.equal(resolveRes.statusCode, 200)
  assert.equal(resolveUpdate.update.$set.activeScopeKey, null)
  assert.equal(resolveUpdate.update.$set.pendingExpiresAt, null)
  assert.equal(resolveUpdate.update.$set.acknowledgedExpiresAt, null)
})

test("pending expiry becomes missed and releases the active scope", async () => {
  const updates = []
  await expireStaleCalls("biz-1", {
    now: new Date("2026-09-04T12:10:00.000Z"),
    ServiceRequestModel: {
      async updateMany(filter, changes) {
        updates.push({ filter, changes })
      },
    },
  })
  const update = updates.find(({ filter }) => filter.status === "pending")
  assert.ok(update)
  assert.equal(update.filter.businessId, "biz-1")
  assert.equal(update.filter.module, "foodService")
  assert.equal(update.changes.$set.status, "missed")
  assert.equal(update.changes.$set.activeScopeKey, null)
})

test("acknowledged request past expiry becomes missed, releases scope, and permits a fresh pending request", async () => {
  const activeScopeKey = JSON.stringify(["biz-1", "foodService", "sp-1"])
  const now = new Date("2026-09-04T12:10:00.000Z")
  let sequence = 1
  let activeCall = {
    _id: "request-1",
    businessId: "biz-1",
    module: "foodService",
    servicePointId: "sp-1",
    status: "acknowledged",
    acknowledgedAt: new Date("2026-09-04T11:59:00.000Z"),
    acknowledgedExpiresAt: new Date("2026-09-04T12:09:00.000Z"),
    activeScopeKey,
  }
  let acknowledgedExpiryFilter
  const model = {
    async updateMany(filter, changes) {
      if (filter.status === "acknowledged") {
        acknowledgedExpiryFilter = filter
      }
      if (
        filter.status === "acknowledged" &&
        activeCall.status === "acknowledged" &&
        activeCall.acknowledgedExpiresAt <= now
      ) {
        Object.assign(activeCall, changes.$set)
        return { modifiedCount: 1 }
      }
      return { modifiedCount: 0 }
    },
    async create(input) {
      if (activeCall.activeScopeKey === input.activeScopeKey) {
        const error = new Error("duplicate")
        error.code = 11000
        throw error
      }
      activeCall = { _id: `request-${++sequence}`, ...input }
      return activeCall
    },
    findOne({ activeScopeKey: requestedScopeKey }) {
      return queryResult(
        activeCall.activeScopeKey === requestedScopeKey ? activeCall : null,
      )
    },
  }

  await expireStaleCalls("biz-1", { ServiceRequestModel: model, now })
  assert.deepEqual(
    acknowledgedExpiryFilter.$or[0],
    { acknowledgedExpiresAt: { $lte: now } },
  )
  assert.equal(activeCall.status, "missed")
  assert.equal(activeCall.activeScopeKey, null)
  assert.equal(activeCall.missedAt, now)

  const next = await createOrGetActiveWaiterCall({
    activeScopeKey,
    callInput: { status: "pending" },
    ServiceRequestModel: model,
  })
  assert.equal(next.created, true)
  assert.equal(next.call.status, "pending")
  assert.equal(next.call._id, "request-2")
})

test("active waiter-call uniqueness is persisted and realtime publication remains in place", async () => {
  const uniqueIndex = ServiceRequest.schema.indexes().find(([keys, options]) => (
    keys.activeScopeKey === 1 && options.unique === true
  ))
  assert.ok(uniqueIndex)
  assert.deepEqual(
    uniqueIndex[1].partialFilterExpression,
    { activeScopeKey: { $type: "string" } },
  )

  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../src/controllers/serviceRequestController.js", import.meta.url),
    "utf8",
  ))
  assert.match(source, /publishEvent\("waiter_call_created"/)
  assert.match(source, /publishEvent\("waiter_call_updated"/)
})
