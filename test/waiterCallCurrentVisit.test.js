import assert from "node:assert/strict"
import test from "node:test"

import Business from "../src/models/Business.js"
import GuestSession from "../src/models/GuestSession.js"
import ServicePoint from "../src/models/ServicePoint.js"
import ServiceRequest from "../src/models/ServiceRequest.js"
import {
  createWaiterCall,
  listWaiterCalls,
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

function guestRequest({
  token = "visit-token",
  businessId = "business-a",
  servicePointId = "sp-a",
  sessionId = "device-a",
} = {}) {
  return {
    body: {
      token,
      businessId,
      servicePointId,
      servicePointLabel: "Table A",
      sessionId,
      reason: "Assistance",
    },
    query: {
      token,
      businessId,
      servicePointId,
      sessionId,
      status: "all",
    },
    headers: {},
    session: {},
    get(name) {
      return this.headers[String(name).toLowerCase()]
    },
    header() {
      return ""
    },
  }
}

async function invokeGuestCreateAndList(overrides) {
  const req = guestRequest(overrides)
  const createResponse = responseRecorder()
  await createWaiterCall(req, createResponse)

  const listResponse = responseRecorder()
  await listWaiterCalls(req, listResponse)
  return { createResponse, listResponse }
}

test("waiter-call guest create and list use canonical current-visit authority", async (t) => {
  const visits = [
    {
      _id: "visit-a",
      token: "visit-token",
      businessId: "business-a",
      servicePointId: "sp-a",
      boundSessionId: "device-a",
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      _id: "expired-visit",
      token: "expired-token",
      businessId: "business-a",
      servicePointId: "sp-a",
      boundSessionId: "device-a",
      expiresAt: new Date(Date.now() - 60_000),
    },
  ]
  const calls = []
  const originalMethods = {
    guestSessionFindOne: GuestSession.findOne,
    businessFindOne: Business.findOne,
    servicePointFindOne: ServicePoint.findOne,
    serviceRequestUpdateMany: ServiceRequest.updateMany,
    serviceRequestFindOne: ServiceRequest.findOne,
    serviceRequestCreate: ServiceRequest.create,
    serviceRequestFind: ServiceRequest.find,
  }

  t.after(() => {
    GuestSession.findOne = originalMethods.guestSessionFindOne
    Business.findOne = originalMethods.businessFindOne
    ServicePoint.findOne = originalMethods.servicePointFindOne
    ServiceRequest.updateMany = originalMethods.serviceRequestUpdateMany
    ServiceRequest.findOne = originalMethods.serviceRequestFindOne
    ServiceRequest.create = originalMethods.serviceRequestCreate
    ServiceRequest.find = originalMethods.serviceRequestFind
  })

  GuestSession.findOne = (filter) => queryResult(
    visits.find((visit) => (
      visit.token === filter.token && visit.businessId === filter.businessId
    )) || null,
  )
  Business.findOne = ({ businessId }) => queryResult({
    businessId,
    businessType: "restaurant",
    modules: ["foodService"],
    orderingPreferences: { callWaiterEnabled: true },
    timezone: "UTC",
  })
  ServicePoint.findOne = (filter) => queryResult(
    filter.businessId === "business-a" && filter.servicePointId === "sp-a"
      ? { businessId: "business-a", servicePointId: "sp-a", label: "Table A", code: "A" }
      : null,
  )
  ServiceRequest.updateMany = async () => ({ modifiedCount: 0 })
  ServiceRequest.findOne = () => queryResult(null)
  ServiceRequest.create = async (input) => {
    const call = { _id: `call-${calls.length + 1}`, ...input, createdAt: new Date() }
    calls.push(call)
    return call
  }
  ServiceRequest.find = (filter) => ({
    sort: () => ({
      lean: async () => calls.filter((call) => (
        call.businessId === filter.businessId &&
        (!filter.servicePointId || call.servicePointId === filter.servicePointId)
      )),
    }),
  })

  await t.test("matching device can create and list its current waiter request", async () => {
    const { createResponse, listResponse } = await invokeGuestCreateAndList()
    assert.equal(createResponse.statusCode, 201)
    assert.equal(createResponse.body.call.businessId, "business-a")
    assert.equal(createResponse.body.call.servicePointId, "sp-a")
    assert.equal(createResponse.body.call.guestSessionId, "visit-a")
    assert.equal(listResponse.statusCode, 200)
    assert.deepEqual(listResponse.body.calls.map((call) => call._id), ["call-1"])
  })

  const rejectedCases = [
    {
      name: "copied token from another device",
      overrides: { sessionId: "device-b" },
      expectedStatus: 403,
    },
    {
      name: "missing device session ID",
      overrides: { sessionId: "" },
      expectedStatus: 400,
    },
    {
      name: "expired GuestSession",
      overrides: { token: "expired-token" },
      expectedStatus: 403,
    },
    {
      name: "valid visit used against another business",
      overrides: { businessId: "business-b" },
      expectedStatus: 403,
    },
    {
      name: "valid visit used against another ServicePoint",
      overrides: { servicePointId: "sp-b" },
      expectedStatus: 403,
    },
  ]

  for (const { name, overrides, expectedStatus } of rejectedCases) {
    await t.test(`${name} cannot create or list waiter requests`, async () => {
      const before = calls.length
      const { createResponse, listResponse } = await invokeGuestCreateAndList(overrides)
      assert.equal(createResponse.statusCode, expectedStatus)
      assert.equal(listResponse.statusCode, expectedStatus)
      assert.equal(calls.length, before)
    })
  }

  await t.test("authenticated staff list remains independent of guest device identity", async () => {
    const res = responseRecorder()
    await listWaiterCalls({
      query: { status: "all" },
      session: { user: { businessId: "business-a" } },
    }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.calls.map((call) => call._id), ["call-1"])
  })
})
