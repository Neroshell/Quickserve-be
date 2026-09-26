import assert from "node:assert/strict"
import test from "node:test"

import {
  getSessionRedisReconnectDelay,
  SESSION_REDIS_RECONNECT_MAX_DELAY_MS,
} from "../src/config/sessionRedisClient.js"
import { resolveReadiness } from "../src/routes/health-route.js"
import {
  handleSessionStoreUnavailable,
  isSessionStoreUnavailableError,
} from "../src/middleware/sessionStoreAvailability.js"
import { startApiRuntime } from "../src/services/apiStartupService.js"
import { INDEX_MODELS, indexMatches } from "../scripts/verify-indexes.js"

test("API listener does not await a pending session Redis connection", async () => {
  const events = []
  const neverConnects = new Promise(() => {})

  const server = await startApiRuntime({
    connectDatabase: async () => { events.push("mongo") },
    listen: () => { events.push("listen"); return { listening: true } },
    connectSessionStore: () => { events.push("redis"); return neverConnects },
    startRealtime: () => { events.push("realtime") },
    logger: { error() {} },
  })

  assert.deepEqual(events, ["mongo", "listen", "redis", "realtime"])
  assert.equal(server.listening, true)
})

test("session Redis reconnect delay is bounded while allowing runtime retries", () => {
  assert.equal(getSessionRedisReconnectDelay(0), 100)
  assert.equal(
    getSessionRedisReconnectDelay(1000),
    SESSION_REDIS_RECONNECT_MAX_DELAY_MS,
  )
})

test("readiness requires both Mongo and session Redis", () => {
  assert.deepEqual(resolveReadiness({ mongoReadyState: 1, sessionRedisReady: true }), {
    ready: true,
    mongo: "connected",
    sessionRedis: "connected",
  })
  assert.equal(
    resolveReadiness({ mongoReadyState: 1, sessionRedisReady: false }).ready,
    false,
  )
})

test("session store outages return a controlled 503 and unrelated errors continue", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
  assert.equal(isSessionStoreUnavailableError(error), true)

  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
  handleSessionStoreUnavailable(error, {}, response, () => assert.fail("must not call next"))
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.code, "SESSION_STORE_UNAVAILABLE")

  const unrelated = new Error("validation failed")
  let forwarded = null
  handleSessionStoreUnavailable(unrelated, {}, response, (nextError) => {
    forwarded = nextError
  })
  assert.equal(forwarded, unrelated)
})

test("index verifier covers ServicePoint and compares integrity options", () => {
  assert.equal(INDEX_MODELS.includes("ServicePoint"), true)
  assert.equal(indexMatches(
    { key: { businessId: 1, servicePointId: 1 }, unique: true },
    { businessId: 1, servicePointId: 1 },
    { unique: true },
  ), true)
  assert.equal(indexMatches(
    { key: { businessId: 1, servicePointId: 1 } },
    { businessId: 1, servicePointId: 1 },
    { unique: true },
  ), false)
})
