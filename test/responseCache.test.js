import assert from "node:assert/strict"
import test from "node:test"

import {
    CACHE_NAMESPACE,
    cacheKeys,
    createResponseCache,
} from "../src/services/responseCacheService.js"

class FakeRedis {
    constructor({ ready = true } = {}) {
        this.isReady = ready
        this.values = new Map()
        this.calls = { get: 0, set: 0, del: 0 }
        this.lastSetOptions = null
    }

    async get(key) {
        this.calls.get += 1
        return this.values.has(key) ? this.values.get(key) : null
    }

    async set(key, value, options) {
        this.calls.set += 1
        this.lastSetOptions = options
        this.values.set(key, value)
        return "OK"
    }

    async del(keys) {
        this.calls.del += 1
        let deleted = 0
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (this.values.delete(key)) deleted += 1
        }
        return deleted
    }
}

function captureLogger() {
    const messages = []
    return {
        messages,
        debug(message) { messages.push(message) },
        warn(message) { messages.push(message) },
    }
}

test("cache keys are versioned, tenant-scoped, encoded, and split by menu audience", () => {
    assert.equal(CACHE_NAMESPACE, "quickserve:v1")
    assert.equal(
        cacheKeys.setupProgress("biz_alpha"),
        "quickserve:v1:business:biz_alpha:setup-progress",
    )
    assert.equal(
        cacheKeys.publicBusinessConfig("biz:alpha"),
        "quickserve:v1:business:biz%3Aalpha:public-config",
    )
    assert.equal(
        cacheKeys.publicBusiness(" MT ", " Alpha Hotel "),
        "quickserve:v1:public-business:mt:alpha%20hotel",
    )
    assert.deepEqual(cacheKeys.menuItemVariants("biz_alpha"), [
        "quickserve:v1:business:biz_alpha:menu-items",
        "quickserve:v1:business:biz_alpha:menu-items:owner",
    ])
    assert.notEqual(
        cacheKeys.menuItems("biz_alpha"),
        cacheKeys.menuItems("biz_beta"),
    )
    assert.throws(() => cacheKeys.setupProgress("  "), /businessId is required/)
})

test("cache miss, set with TTL, hit, and invalidation round-trip JSON payloads", async () => {
    const client = new FakeRedis()
    const logger = captureLogger()
    const cache = createResponseCache({ client, logger })
    const key = cacheKeys.publicBusinessConfig("biz_alpha")
    const payload = { businessId: "biz_alpha", nested: { enabled: true } }

    assert.deepEqual(await cache.get(key), { hit: false, value: null })
    assert.equal(await cache.set(key, payload, 600), true)
    assert.deepEqual(client.lastSetOptions, { EX: 600 })
    assert.deepEqual(await cache.get(key), { hit: true, value: payload })
    assert.equal(await cache.delMany([key, key]), true)
    assert.equal(client.calls.del, 1, "duplicate keys should be deleted once")
    assert.deepEqual(await cache.get(key), { hit: false, value: null })

    assert.ok(logger.messages.some(message => message.includes("MISS")))
    assert.ok(logger.messages.some(message => message.includes("HIT")))
    assert.ok(logger.messages.some(message => message.includes("invalidated")))
})

test("Redis errors and unavailable clients fail open for every cache operation", async () => {
    const logger = captureLogger()
    const failingClient = {
        isReady: true,
        async get() { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }) },
        async set() { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }) },
        async del() { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }) },
    }
    const cache = createResponseCache({ client: failingClient, logger })

    assert.deepEqual(await cache.get("key"), { hit: false, value: null })
    assert.equal(await cache.set("key", { value: 1 }, 60), false)
    assert.equal(await cache.del("key"), false)
    assert.ok(logger.messages.some(message => message.includes("GET failure")))
    assert.ok(logger.messages.some(message => message.includes("SET failure")))
    assert.ok(logger.messages.some(message => message.includes("invalidation failure")))

    const unavailable = createResponseCache({
        client: new FakeRedis({ ready: false }),
        logger,
    })
    assert.deepEqual(await unavailable.get("key"), { hit: false, value: null })
    assert.equal(await unavailable.set("key", {}, 60), false)
    assert.equal(await unavailable.del("key"), false)
})

test("a stalled Redis command times out and becomes a cache miss", async () => {
    const cache = createResponseCache({
        client: {
            isReady: true,
            get() { return new Promise(() => {}) },
        },
        logger: captureLogger(),
        commandTimeoutMs: 10,
    })

    const startedAt = Date.now()
    assert.deepEqual(await cache.get("slow-key"), { hit: false, value: null })
    assert.ok(Date.now() - startedAt < 250)
})

test("invalid JSON is treated as a miss so MongoDB can heal the cache", async () => {
    const client = new FakeRedis()
    const logger = captureLogger()
    client.values.set("bad-key", "{not-json")
    const cache = createResponseCache({ client, logger })

    assert.deepEqual(await cache.get("bad-key"), { hit: false, value: null })
    assert.ok(logger.messages.some(message => message.includes("GET failure")))
})
