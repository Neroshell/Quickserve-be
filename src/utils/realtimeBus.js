// realtimeBus.js
//
// Subscribes to the shared Redis pub/sub channel.
// On each message: parses the canonical event envelope and calls broadcastLocal()
// to deliver to matching SSE clients on THIS instance.
//
// Call startRealtimeBus() once at server startup, after connectDB().

import { redisSub, REDIS_CHANNEL } from "../config/redisClient.js"
import { broadcastLocal } from "./sseManager.js"

export function startRealtimeBus() {
    if (!redisSub) {
        console.warn(
            "[RealtimeBus] REDIS_URL not set — Redis subscriber not started. " +
            "Running in local single-process mode (direct in-memory broadcast)."
        )
        return
    }

    redisSub.subscribe(REDIS_CHANNEL, (err, count) => {
        if (err) {
            console.error("[RealtimeBus] ❌ Failed to subscribe to Redis channel:", err.message)
            return
        }
        console.log(`[RealtimeBus] ✅ Subscribed to channel "${REDIS_CHANNEL}" (${count} subscription(s))`)
    })

    redisSub.on("message", (channel, rawMessage) => {
        if (channel !== REDIS_CHANNEL) return

        let msg
        try {
            msg = JSON.parse(rawMessage)
        } catch (err) {
            console.error("[RealtimeBus] ❌ Failed to parse Redis message:", rawMessage, err.message)
            return
        }

        const { event, businessId, targets, payload } = msg

        if (!event || !businessId || !payload) {
            console.warn("[RealtimeBus] ⚠️ Received malformed message — missing required fields:", msg)
            return
        }

        console.log(
            `[RealtimeBus] 📨 Received event=${event} businessId=${businessId} targets=${JSON.stringify(targets ?? "all")}`
        )

        broadcastLocal({ event, businessId, targets: targets ?? null, payload })
    })

    redisSub.on("error", (err) => {
        console.error("[RealtimeBus] ❌ Subscriber connection error:", err.message)
    })
}
