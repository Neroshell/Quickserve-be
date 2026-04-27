// sseManager.js
//
// Responsibilities:
//   1. Track locally-connected SSE clients (per-instance in-memory Set)
//   2. Register/deregister clients via sseHandler
//   3. broadcastLocal(msg) — deliver a canonical event message to matching local clients
//   4. publishEvent(event, businessId, targets, payload) — publish to Redis
//      OR broadcast directly (local fallback when Redis is unavailable)
//
// ─────────────────────────────────────────────────────────────────────────────
// Event shape published to Redis and forwarded via SSE:
//   {
//     event:        string,          // e.g. "order_created"
//     businessId:   string,          // scoping: only clients with this businessId receive it
//     targets:      string[]|null,   // role whitelist, e.g. ["kitchen"], null = all roles
//     payload:      object           // data forwarded verbatim as SSE data:
//   }
// ─────────────────────────────────────────────────────────────────────────────

import { redisPub, REDIS_CHANNEL } from "../config/redisClient.js"

// ── Local client registry ────────────────────────────────────────────────────
const clients = new Set()

function addClient(client) {
    clients.add(client)
    console.log(
        `[SSE] ✅ Client connected — role=${client.role} businessId=${client.businessId} total=${clients.size}`
    )
}

function removeClient(client) {
    clients.delete(client)
    console.log(
        `[SSE] 🔌 Client disconnected — role=${client.role} businessId=${client.businessId} total=${clients.size}`
    )
}

// ── SSE HTTP handler ─────────────────────────────────────────────────────────
export function sseHandler(req, res) {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")   // disable nginx proxy buffering
    res.flushHeaders?.()

    const role = req.query.role || "anon"
    const businessId = req.query.businessId || req.query.restaurantId || "default-business-id"
    const client = { res, role, businessId }

    addClient(client)

    // Initial heartbeat so the browser's EventSource opens immediately
    res.write(
        `event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now(), role, businessId })}\n\n`
    )

    // Keep-alive ping every 25 s (prevents idle disconnects through proxies/load balancers)
    const keepAlive = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`)
        } catch (err) {
            console.error("[SSE] Heartbeat write failed, removing client:", err.message)
            clearInterval(keepAlive)
            removeClient(client)
        }
    }, 25_000)

    req.on("close", () => {
        clearInterval(keepAlive)
        removeClient(client)
    })
}

// ── Local delivery ───────────────────────────────────────────────────────────
/**
 * Deliver a canonical event message to all matching SSE clients on THIS instance.
 * Called by the Redis subscriber when a message arrives on the channel, as well
 * as directly when Redis is not available (local dev fallback).
 *
 * @param {{ event: string, businessId: string, targets: string[]|null, payload: object }} msg
 */
export function broadcastLocal(msg) {
    const { event, businessId, targets, payload } = msg

    if (!event || !businessId) {
        console.warn("[SSE] broadcastLocal called with missing event or businessId — skipping", msg)
        return
    }

    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    let matched = 0

    for (const client of clients) {
        // Business isolation — strict
        if (client.businessId !== businessId) continue

        // Role targeting — if targets is null/empty every role passes
        if (targets && targets.length > 0 && !targets.includes(client.role)) continue

        try {
            client.res.write(data)
            matched++
        } catch (err) {
            console.error("[SSE] Write failed, removing client:", err.message)
            removeClient(client)
        }
    }

    console.log(
        `[SSE] broadcastLocal event=${event} businessId=${businessId} targets=${JSON.stringify(targets ?? "all")} matched=${matched}/${clients.size}`
    )
}

// ── Redis publish (production) / direct fallback (local dev) ─────────────────
/**
 * The single public API for emitting realtime events from business logic.
 *
 * In production (REDIS_URL set):
 *   Publishes a canonical JSON message to the shared Redis channel. Every subscribed
 *   instance (including this one) will receive it via realtimeBus.js and call broadcastLocal.
 *
 * In local dev (REDIS_URL not set, redisPub === null):
 *   Falls back to calling broadcastLocal directly on this process — preserving the
 *   existing single-process localhost experience with no extra setup required.
 *
 * @param {string}            event        SSE event name, e.g. "order_created"
 * @param {string}            businessId   Business scope
 * @param {string[]|null}     targets      Role whitelist, e.g. ["kitchen"], or null for all
 * @param {object}            payload      Data forwarded verbatim to the browser
 */
export async function publishEvent(event, businessId, targets, payload) {
    const msg = { event, businessId, targets: targets ?? null, payload }

    if (!redisPub) {
        // Local dev fallback: no Redis, broadcast directly in this process
        console.log(`[RealtimeBus] (local fallback) publishEvent event=${event} businessId=${businessId}`)
        broadcastLocal(msg)
        return
    }

    try {
        await redisPub.publish(REDIS_CHANNEL, JSON.stringify(msg))
        console.log(
            `[RealtimeBus] ✅ Published event=${event} businessId=${businessId} targets=${JSON.stringify(targets ?? "all")}`
        )
    } catch (err) {
        console.error("[RealtimeBus] ❌ Redis PUBLISH failed, using local fallback:", err.message)
        // Graceful fallback: deliver on this instance even if Redis is temporarily down
        broadcastLocal(msg)
    }
}

// ── Legacy compatibility shims ────────────────────────────────────────────────
// These allow existing call sites that have not been migrated yet to keep working.
// They are thin wrappers over publishEvent and will be removed once all controllers
// use publishEvent directly.

/**
 * @deprecated Use publishEvent() instead.
 */
export function broadcast(eventName, payload, filterFn = null) {
    const businessId =
        payload.businessId ||
        payload.restaurantId ||
        (payload.order && payload.order.businessId) ||
        (payload.order && payload.order.restaurantId) ||
        (payload.call && payload.call.businessId) ||
        (payload.call && payload.call.restaurantId)

    publishEvent(eventName, businessId, null, payload).catch((err) =>
        console.error("[SSE] broadcast shim error:", err)
    )
}

/**
 * @deprecated Use publishEvent() instead.
 */
export function broadcastToRole(targetRole, eventName, payload) {
    const businessId =
        payload.businessId ||
        payload.restaurantId ||
        (payload.order && payload.order.businessId) ||
        (payload.order && payload.order.restaurantId) ||
        (payload.call && payload.call.businessId) ||
        (payload.call && payload.call.restaurantId)

    publishEvent(eventName, businessId, [targetRole], payload).catch((err) =>
        console.error("[SSE] broadcastToRole shim error:", err)
    )
}
