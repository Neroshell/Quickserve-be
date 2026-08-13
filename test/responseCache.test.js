import assert from "node:assert/strict"
import test from "node:test"

import {
    CACHE_NAMESPACE,
    DEFAULT_CACHE_COMMAND_TIMEOUT_MS,
    cacheKeys,
    createResponseCache,
    resolveCacheCommandTimeoutMs,
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
    assert.ok(logger.messages.some(message => message.includes("command=GET failure")))
    assert.ok(logger.messages.some(message => message.includes("command=SET failure")))
    assert.ok(logger.messages.some(message => message.includes("command=DEL failure")))

    const unavailable = createResponseCache({
        client: new FakeRedis({ ready: false }),
        logger,
    })
    assert.deepEqual(await unavailable.get("key"), { hit: false, value: null })
    assert.equal(await unavailable.set("key", {}, 60), false)
    assert.equal(await unavailable.del("key"), false)
})

test("cache command timeout uses the 500ms default and a positive env override", () => {
    assert.equal(DEFAULT_CACHE_COMMAND_TIMEOUT_MS, 500)
    assert.equal(resolveCacheCommandTimeoutMs({}), 500)
    assert.equal(resolveCacheCommandTimeoutMs({ CACHE_COMMAND_TIMEOUT_MS: "750" }), 750)
    assert.equal(resolveCacheCommandTimeoutMs({ CACHE_COMMAND_TIMEOUT_MS: "0" }), 500)
    assert.equal(resolveCacheCommandTimeoutMs({ CACHE_COMMAND_TIMEOUT_MS: "invalid" }), 500)
})

test("a Redis GET under the threshold returns a HIT", async () => {
    const cache = createResponseCache({
        client: {
            isReady: true,
            async get() {
                await new Promise(resolve => setTimeout(resolve, 5))
                return JSON.stringify({ source: "cache" })
            },
        },
        logger: captureLogger(),
        commandTimeoutMs: 50,
    })

    assert.deepEqual(await cache.get("quickserve:v1:business:biz_alpha:menu-items"), {
        hit: true,
        value: { source: "cache" },
    })
})

test("a stalled Redis GET times out once, aborts queued work, and fails open to the database", async () => {
    let getCalls = 0
    let aborts = 0
    let databaseReads = 0
    const client = {
        isReady: true,
        withAbortSignal(signal) {
            return {
                get() {
                    getCalls += 1
                    return new Promise((_, reject) => {
                        signal.addEventListener("abort", () => {
                            aborts += 1
                            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
                        }, { once: true })
                    })
                },
            }
        },
    }
    const logger = captureLogger()
    const cache = createResponseCache({
        client,
        logger,
        commandTimeoutMs: 10,
    })

    const startedAt = Date.now()
    const cached = await cache.get("quickserve:v1:business:biz_alpha:menu-items")
    const value = cached.hit ? cached.value : await (async () => {
        databaseReads += 1
        return { source: "database" }
    })()

    assert.deepEqual(value, { source: "database" })
    assert.ok(Date.now() - startedAt < 250)
    assert.equal(getCalls, 1)
    assert.equal(aborts, 1)
    assert.equal(databaseReads, 1)
    assert.ok(logger.messages.some(message =>
        message.includes("command=GET failure") &&
        message.includes("domain=menu-items") &&
        message.includes("timeoutMs=10") &&
        message.includes("reason=CACHE_COMMAND_TIMEOUT")
    ))
})

test("repeated identical timeouts are rate-limited without retrying commands", async () => {
    let getCalls = 0
    const logger = captureLogger()
    const cache = createResponseCache({
        client: {
            isReady: true,
            get() {
                getCalls += 1
                return new Promise(() => {})
            },
        },
        logger,
        commandTimeoutMs: 5,
    })

    await cache.get("quickserve:v1:business:biz_alpha:menu-items")
    await cache.get("quickserve:v1:business:biz_beta:menu-items")
    await new Promise(resolve => setTimeout(resolve, 15))

    assert.equal(getCalls, 2, "one client command should be issued per caller; no retries")
    assert.equal(
        logger.messages.filter(message => message.includes("reason=CACHE_COMMAND_TIMEOUT")).length,
        1,
        "identical command/domain timeout warnings should be rate-limited",
    )
})

test("Redis SET and DEL failures stay fail-open for the authoritative request path", async () => {
    let authoritativeWrites = 0
    const cache = createResponseCache({
        client: {
            isReady: true,
            async set() { throw Object.assign(new Error("set down"), { code: "ECONNRESET" }) },
            async del() { throw Object.assign(new Error("del down"), { code: "ECONNRESET" }) },
        },
        logger: captureLogger(),
    })

    authoritativeWrites += 1
    const cacheStored = await cache.set("quickserve:v1:business:biz_alpha:menu-items", { fresh: true }, 60)
    const cacheInvalidated = await cache.del("quickserve:v1:business:biz_alpha:menu-items")

    assert.equal(authoritativeWrites, 1)
    assert.equal(cacheStored, false)
    assert.equal(cacheInvalidated, false)
})

test("invalid JSON is treated as a miss so MongoDB can heal the cache", async () => {
    const client = new FakeRedis()
    const logger = captureLogger()
    client.values.set("bad-key", "{not-json")
    const cache = createResponseCache({ client, logger })

    assert.deepEqual(await cache.get("bad-key"), { hit: false, value: null })
    assert.ok(logger.messages.some(message => message.includes("command=GET failure")))
})
