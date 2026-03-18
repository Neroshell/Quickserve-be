// redisClient.js
// Two dedicated ioredis connections are required:
//   - redisPub  → used exclusively to PUBLISH events
//   - redisSub  → used exclusively to SUBSCRIBE (a subscribed client cannot publish)
//
// If REDIS_URL is absent (local dev without Redis) both are null and the system
// falls back to direct in-process broadcast inside sseManager.js.

import Redis from "ioredis"

function createClient(role) {
    const url = process.env.REDIS_URL
    if (!url) {
        console.warn(`[Redis] REDIS_URL not set — ${role} client is null (local fallback active)`)
        return null
    }

    const client = new Redis(url, {
        maxRetriesPerRequest: null,      // required for blocking commands; harmless for normal use
        enableReadyCheck: false,          // Upstash doesn't support CLIENT INFO used in ready check
        lazyConnect: false,
        retryStrategy(times) {
            const delay = Math.min(times * 200, 5000)
            console.warn(`[Redis:${role}] Reconnect attempt #${times}, waiting ${delay}ms`)
            return delay
        },
        tls: url.startsWith("rediss://") ? {} : undefined,  // enforce TLS for rediss:// URLs
    })

    client.on("connect", () => console.log(`[Redis:${role}] ✅ Connected to Redis`))
    client.on("ready", () => console.log(`[Redis:${role}] ✅ Ready`))
    client.on("error", (err) => console.error(`[Redis:${role}] ❌ Error:`, err.message))
    client.on("close", () => console.warn(`[Redis:${role}] ⚠️ Connection closed`))
    client.on("reconnecting", () => console.warn(`[Redis:${role}] 🔄 Reconnecting...`))

    return client
}

export const redisPub = createClient("pub")
export const redisSub = createClient("sub")

export const REDIS_CHANNEL = "quickserve:events"
