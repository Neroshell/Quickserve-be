import { describe, test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { ThrottledRedisStore, DEFAULT_TOUCH_THROTTLE_MS } from "../src/config/throttledRedisStore.js"

// Mock Redis Client tracking command invocations
function createMockRedisClient() {
    const store = new Map()
    const calls = { set: [], expire: [], get: [], del: [] }

    return {
        store,
        calls,
        async set(key, value, opts) {
            calls.set.push({ key, value, opts })
            store.set(key, value)
            return "OK"
        },
        async expire(key, seconds) {
            calls.expire.push({ key, seconds })
            if (!store.has(key)) return 0
            return 1
        },
        async get(key) {
            calls.get.push({ key })
            return store.get(key) || null
        },
        async del(keys) {
            calls.del.push({ keys })
            let count = 0
            for (const key of keys) {
                if (store.delete(key)) count++
            }
            return count
        },
    }
}

describe("ThrottledRedisStore Tests", () => {
    let mockClient
    let store

    beforeEach(() => {
        mockClient = createMockRedisClient()
        store = new ThrottledRedisStore({
            client: mockClient,
            prefix: "qs:sess:",
            ttl: 28800, // 8 hours in seconds
        })
    })

    test("8-hour TTL remains configured and getTTL calculates correctly", () => {
        const session = { cookie: { maxAge: 8 * 60 * 60 * 1000 } }
        const ttl = store.getTTL(session)
        assert.equal(ttl, 28800) // 8 hours in seconds
    })

    test("first session request establishes and saves normally via set()", async () => {
        const sid = "session-1"
        const session = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }

        await store.set(sid, session)

        assert.equal(mockClient.calls.set.length, 1)
        assert.equal(mockClient.calls.set[0].key, "qs:sess:session-1")
        assert.equal(store.lastTouched.has(sid), true)
    })

    test("repeated requests within 15 minutes do not repeatedly call Redis EXPIRE", async () => {
        const sid = "session-1"
        const session = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }

        // Initial set on login
        await store.set(sid, session)
        assert.equal(mockClient.calls.set.length, 1)
        assert.equal(mockClient.calls.expire.length, 0)

        // Subsequent requests within 15 minutes trigger touch()
        await store.touch(sid, session)
        await store.touch(sid, session)
        await store.touch(sid, session)

        // All touch calls within 15 minutes are throttled — 0 expire commands issued
        assert.equal(mockClient.calls.expire.length, 0)
    })

    test("request after 15+ minutes allows one touch (EXPIRE command)", async () => {
        const sid = "session-1"
        const session = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }

        await store.set(sid, session)
        assert.equal(mockClient.calls.expire.length, 0)

        // Simulate 16 minutes passing
        const initialTouchTime = store.lastTouched.get(sid)
        store.lastTouched.set(sid, initialTouchTime - (16 * 60 * 1000))

        // Request at t=16m triggers touch()
        await store.touch(sid, session)

        // Exactly one EXPIRE command issued
        assert.equal(mockClient.calls.expire.length, 1)
        assert.equal(mockClient.calls.expire[0].key, "qs:sess:session-1")
        assert.equal(mockClient.calls.expire[0].seconds, 28800)
    })

    test("repeated requests after a 15+ min touch are throttled again", async () => {
        const sid = "session-1"
        const session = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }

        await store.set(sid, session)

        // Fast-forward 16 minutes & touch
        store.lastTouched.set(sid, Date.now() - (16 * 60 * 1000))
        await store.touch(sid, session)
        assert.equal(mockClient.calls.expire.length, 1)

        // Immediate subsequent touches should be throttled
        await store.touch(sid, session)
        await store.touch(sid, session)
        assert.equal(mockClient.calls.expire.length, 1) // Still only 1 EXPIRE call
    })

    test("explicit session mutation (set) still persists immediately", async () => {
        const sid = "session-1"
        const session1 = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }
        const session2 = { cookie: { maxAge: 28800000 }, user: { id: "u1" }, cart: ["item1"] }

        await store.set(sid, session1)
        assert.equal(mockClient.calls.set.length, 1)

        // Throttled touch
        await store.touch(sid, session1)
        assert.equal(mockClient.calls.set.length, 1)

        // Mutation causes explicit set()
        await store.set(sid, session2)
        assert.equal(mockClient.calls.set.length, 2)
    })

    test("logout (destroy) removes session from Redis and clears lastTouched map", async () => {
        const sid = "session-1"
        const session = { cookie: { maxAge: 28800000 }, user: { id: "u1" } }

        await store.set(sid, session)
        assert.equal(store.lastTouched.has(sid), true)

        await store.destroy(sid)

        assert.equal(mockClient.calls.del.length, 1)
        assert.equal(mockClient.calls.del[0].keys[0], "qs:sess:session-1")
        assert.equal(store.lastTouched.has(sid), false)
    })

    test("expired/missing session in Redis returns null on get()", async () => {
        const sid = "expired-session"
        const result = await new Promise((resolve) => store.get(sid, (err, sess) => resolve(sess)))
        assert.equal(result, null)
    })

    test("multiple sessions are throttled independently", async () => {
        const sid1 = "session-1"
        const sid2 = "session-2"
        const session = { cookie: { maxAge: 28800000 } }

        await store.set(sid1, session)
        await store.set(sid2, session)

        // Fast forward sid1 only
        store.lastTouched.set(sid1, Date.now() - (16 * 60 * 1000))

        await store.touch(sid1, session) // Should execute EXPIRE for sid1
        await store.touch(sid2, session) // Should be throttled for sid2

        assert.equal(mockClient.calls.expire.length, 1)
        assert.equal(mockClient.calls.expire[0].key, "qs:sess:session-1")
    })
})
