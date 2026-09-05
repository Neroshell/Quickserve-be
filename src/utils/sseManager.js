// sseManager.js
//
// Responsibilities:
//   1. Track locally-connected SSE clients (per-instance in-memory Set)
//   2. Register/deregister clients via sseHandler
//   3. broadcastLocal(msg) — deliver a canonical event message to matching local clients
//   4. publishEvent(event, businessId, targets, payload) — deliver locally,
//      then publish to Redis for cross-instance fan-out when configured
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

import { randomUUID } from "node:crypto"
import { redisPub, REDIS_CHANNEL } from "../config/redisClient.js"
import GuestSession from "../models/GuestSession.js"
import Staff from "../models/Staff.js"
import { resolveCurrentCoOwner, resolveCurrentManager } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"
import {
    MANAGEMENT_AREA_BY_PERMISSION,
    resolveManagementAccess,
} from "../constants/managementAccess.js"

// Which SSE channel(s) a given authenticated staff role is allowed to subscribe to.
// The channel is derived from the session role — NOT the client-supplied query —
// so a kitchen/bar staffer can't spoof role=waiter to read the full order stream.
// (Staff role enum is waiter/kitchen/manager/bartender/co_owner/owner; the SSE
// channel names are kitchen/bar/waiter/owner — note bartender → "bar".)
const SSE_CHANNELS_BY_ROLE = {
    kitchen: ["kitchen"],
    bartender: ["bar"],
    waiter: ["waiter", "reservations"],
    manager: ["kitchen", "bar", "waiter", "owner", "reservations"],
    owner: ["kitchen", "bar", "waiter", "owner", "reservations"],
    co_owner: ["kitchen", "bar", "waiter", "owner", "reservations"],
    admin: ["kitchen", "bar", "waiter", "owner", "reservations"],
}

// Customer-facing SSE roles — these streams are scoped to a single table.
const CUSTOMER_ROLES = new Set(["table", "anon", "customer"])

// Owner/dashboard SSE clients receive all staff-targeted operational events
// (order_created, order_updated, waiter_call_*) regardless of which specific
// staff channel (kitchen/bar/waiter) the event was published to. This is safe
// because the owner dashboard uses events purely as invalidation signals and
// ignores event payloads. Tenant isolation (businessId) is still enforced.
const SSE_DASHBOARD_ROLES = new Set(["owner"])

const MANAGER_SSE_PERMISSIONS_BY_CHANNEL = {
    kitchen: new Set([PERMISSIONS.ORDERS_VIEW]),
    bar: new Set([PERMISSIONS.ORDERS_VIEW]),
    waiter: new Set([PERMISSIONS.ORDERS_VIEW]),
    owner: new Set([
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.ORDERS_VIEW,
        PERMISSIONS.STAFF_VIEW,
    ]),
    reservations: new Set([PERMISSIONS.RESERVATIONS_VIEW]),
}

const MANAGER_ACCESS_REVOKED_EVENT = "__manager_access_revoked"
const MANAGEMENT_ACCESS_REVOKED_EVENT = "__management_access_revoked"

function managerPermissionAllowsEvent(permission, event) {
    if (permission === PERMISSIONS.DASHBOARD_VIEW) return true
    if (permission === PERMISSIONS.ORDERS_VIEW) return event.startsWith("order_")
    if (permission === PERMISSIONS.STAFF_VIEW) return event.startsWith("staff_")
    if (permission === PERMISSIONS.RESERVATIONS_VIEW) return event.startsWith("reservation_")
    return false
}

// ── Local client registry ────────────────────────────────────────────────────
const clients = new Set()

// Redis distributes events to other API instances. The publishing instance
// also delivers directly to its own SSE clients so a stalled subscriber cannot
// make a successfully committed action appear frozen until the next refresh.
// The origin id lets the healthy Redis round-trip skip that local duplicate.
export const REALTIME_INSTANCE_ID = randomUUID()

function addClient(client) {
    clients.add(client)
    console.log(
        `[SSE] ✅ Client connected — role=${client.role} businessId=${client.businessId} total=${clients.size}`
    )
}

function removeClient(client) {
    if (!clients.delete(client)) return
    if (client.keepAlive) clearInterval(client.keepAlive)
    console.log(
        `[SSE] 🔌 Client disconnected — role=${client.role} businessId=${client.businessId} total=${clients.size}`
    )
}

async function findCurrentManagerForClient(client) {
    const identityFilter = client.managerIdentity?.staffObjectId
        ? { _id: client.managerIdentity.staffObjectId }
        : { staffId: client.managerIdentity?.staffId }

    try {
        return await Staff.findOne({
            ...identityFilter,
            businessId: client.businessId,
            role: "manager",
            accountStatus: "active",
        })
            .select("permissions")
            .lean()
    } catch (err) {
        console.error("[SSE] Failed to revalidate Manager stream:", err.message)
        return null
    }
}

async function findCurrentCoOwnerForClient(client) {
    const identityFilter = client.managementIdentity?.staffObjectId
        ? { _id: client.managementIdentity.staffObjectId }
        : { staffId: client.managementIdentity?.staffId }

    try {
        return await Staff.findOne({
            ...identityFilter,
            businessId: client.businessId,
            role: "co_owner",
            accountStatus: "active",
        })
            .select("coOwnerRestrictions")
            .lean()
    } catch (err) {
        console.error("[SSE] Failed to revalidate Co-Owner stream:", err.message)
        return null
    }
}

// ── SSE HTTP handler ─────────────────────────────────────────────────────────
export async function sseHandler(req, res) {
    let role = req.query.role || "anon"
    const businessId = req.query.businessId || req.query.businessId
    const token = req.query.token
    let managerPermission = null
    let managerIdentity = null
    let coOwnerArea = null
    let managementIdentity = null

    if (!businessId) {
        return res.status(400).end("Missing businessId")
    }

    // ── Authentication & Authorization ─────────────────────────────────────────
    let clientTableId = null
    if (role === "table" || role === "anon" || role === "customer") {
        if (!token) {
            return res.status(401).end("Missing session token")
        }
        const ts = await GuestSession.findOne({ token, businessId }).lean()
        if (!ts || ts.expiresAt < new Date()) {
            return res.status(403).end("Invalid or expired table session")
        }
        // Per-table isolation: this customer stream only receives events for its
        // own table (see broadcastLocal). Staff streams stay business-wide.
        clientTableId = ts.servicePointId || null
    } else {
        // Staff roles (waiter, kitchen, bartender, owner, etc.)
        if (!req.session || !req.session.user) {
            return res.status(401).end("Unauthorized. Please log in.")
        }
        if (req.session.user.businessId !== businessId) {
            return res.status(403).end("Forbidden. businessId mismatch.")
        }

        // Anti-spoofing: pin the channel to what this session role is allowed to
        // receive. A staffer cannot read another role's stream by changing ?role=.
        const allowedChannels = SSE_CHANNELS_BY_ROLE[req.session.user.role] || []
        if (allowedChannels.length === 0) {
            return res.status(403).end("Forbidden. Role not permitted for live updates.")
        }
        if (!allowedChannels.includes(role)) {
            role = allowedChannels[0]
        }

        if (req.session.user.role === "manager") {
            const requestedPermission = req.query.permission
            const allowedPermissions = MANAGER_SSE_PERMISSIONS_BY_CHANNEL[role]
            const manager = await resolveCurrentManager(req)
            if (
                !manager ||
                !allowedPermissions?.has(requestedPermission) ||
                !req.resolvedManagerPermissions.includes(requestedPermission)
            ) {
                return res.status(403).end("Forbidden. Manager live-update permission denied.")
            }
            managerPermission = requestedPermission
            managerIdentity = {
                staffObjectId: String(manager._id),
                staffId: manager.staffId,
            }
            managementIdentity = managerIdentity
        } else if (req.session.user.role === "co_owner") {
            const requestedPermission = req.query.permission
            const allowedPermissions = MANAGER_SSE_PERMISSIONS_BY_CHANNEL[role]
            const requestedArea = MANAGEMENT_AREA_BY_PERMISSION[requestedPermission]
            const coOwner = await resolveCurrentCoOwner(req)
            if (
                !coOwner ||
                !allowedPermissions?.has(requestedPermission) ||
                !resolveManagementAccess({
                    role: "co_owner",
                    coOwnerRestrictions: req.resolvedCoOwnerRestrictions,
                }, { area: requestedArea })
            ) {
                return res.status(403).end("Forbidden. Co-Owner live-update access denied.")
            }
            managerPermission = requestedPermission
            coOwnerArea = requestedArea
            managementIdentity = {
                staffObjectId: String(coOwner._id),
                staffId: coOwner.staffId,
            }
        }
    }

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")   // disable nginx proxy buffering
    res.flushHeaders?.()

    const client = {
        res,
        role,
        businessId,
        servicePointId: clientTableId,
        managerPermission,
        managerIdentity,
        coOwnerArea,
        managementIdentity,
    }

    addClient(client)

    // Initial heartbeat so the browser's EventSource opens immediately
    res.write(
        `event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now(), role, businessId })}\n\n`
    )

    // Keep-alive ping every 25 s (prevents idle disconnects through proxies/load balancers)
    const keepAlive = setInterval(async () => {
        try {
            if (client.managerPermission) {
                const currentManager = client.coOwnerArea
                    ? await findCurrentCoOwnerForClient(client)
                    : await findCurrentManagerForClient(client)
                if (!clients.has(client)) return
                const stillAllowed = client.coOwnerArea
                    ? Boolean(currentManager && resolveManagementAccess({
                        role: "co_owner",
                        coOwnerRestrictions: currentManager.coOwnerRestrictions || [],
                    }, { area: client.coOwnerArea }))
                    : currentManager?.permissions?.includes(client.managerPermission)
                if (!stillAllowed) {
                    res.end()
                    clearInterval(keepAlive)
                    removeClient(client)
                    return
                }
            }
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`)
        } catch (err) {
            console.error("[SSE] Heartbeat write failed, removing client:", err.message)
            clearInterval(keepAlive)
            removeClient(client)
        }
    }, 25_000)
    client.keepAlive = keepAlive

    req.on("close", () => {
        clearInterval(keepAlive)
        removeClient(client)
    })
}

/**
 * End any live streams for a Manager whose permissions changed. EventSource
 * reconnects automatically and the new connection performs a fresh MongoDB
 * authorization check.
 */
export function disconnectManagerClients({ businessId, staffObjectId, staffId }) {
    let disconnected = 0
    for (const client of [...clients]) {
        if (client.businessId !== businessId || !client.managerIdentity) continue
        const isTarget =
            (staffObjectId && client.managerIdentity.staffObjectId === String(staffObjectId)) ||
            (staffId && client.managerIdentity.staffId === staffId)
        if (!isTarget) continue

        try {
            client.res.end()
        } catch (err) {
            console.error("[SSE] Failed to close stale Manager stream:", err.message)
        } finally {
            removeClient(client)
            disconnected++
        }
    }
    return disconnected
}

export function disconnectManagementClients({ businessId, staffObjectId, staffId }) {
    let disconnected = 0
    for (const client of [...clients]) {
        if (client.businessId !== businessId || !client.managementIdentity) continue
        const isTarget =
            (staffObjectId && client.managementIdentity.staffObjectId === String(staffObjectId)) ||
            (staffId && client.managementIdentity.staffId === staffId)
        if (!isTarget) continue

        try {
            client.res.end()
        } catch (err) {
            console.error("[SSE] Failed to close stale management stream:", err.message)
        } finally {
            removeClient(client)
            disconnected++
        }
    }
    return disconnected
}

// ── Local delivery ───────────────────────────────────────────────────────────
/**
 * Deliver a canonical event message to all matching SSE clients on THIS instance.
 * Called by the Redis subscriber when a message arrives on the channel, as well
 * as directly when Redis is not available (local dev fallback).
 *
 * @param {{ event: string, businessId: string, targets: string[]|null, payload: object }} msg
 */
export async function broadcastLocal(msg) {
    const { event, businessId, targets, payload } = msg

    if (!event || !businessId) {
        console.warn("[SSE] broadcastLocal called with missing event or businessId — skipping", msg)
        return
    }

    // Internal control message distributed over the existing realtime bus.
    // It is consumed by every app instance and is never forwarded to clients.
    if (event === MANAGER_ACCESS_REVOKED_EVENT) {
        disconnectManagerClients({
            businessId,
            staffObjectId: payload?.staffObjectId,
            staffId: payload?.staffId,
        })
        return
    }
    if (event === MANAGEMENT_ACCESS_REVOKED_EVENT) {
        disconnectManagementClients({
            businessId,
            staffObjectId: payload?.staffObjectId,
            staffId: payload?.staffId,
        })
        return
    }

    // The table this event belongs to, if any. Orders and waiter calls carry the
    // identity used to scope customer streams below. Waiter calls use only the
    // canonical servicePointId; the order fallback remains unchanged.
    const msgTableId =
        payload?.order?.servicePointLabel ||
        payload?.call?.servicePointId ||
        null

    let matched = 0
    const managerAuthorizationByIdentity = new Map()

    for (const client of clients) {
        // Business isolation — strict
        if (client.businessId !== businessId) continue

        // Role targeting — if targets is null/empty every role passes.
        // Dashboard roles (owner) bypass target filtering to receive all
        // staff-targeted operational events as invalidation signals.
        if (targets && targets.length > 0 && !targets.includes(client.role) && !SSE_DASHBOARD_ROLES.has(client.role)) continue

        if (client.managerPermission) {
            if (!managerPermissionAllowsEvent(client.managerPermission, event)) continue

            const identityKey = `${client.businessId}:${client.managementIdentity?.staffObjectId || client.managementIdentity?.staffId || "unknown"}`
            if (!managerAuthorizationByIdentity.has(identityKey)) {
                managerAuthorizationByIdentity.set(
                    identityKey,
                    client.coOwnerArea
                        ? findCurrentCoOwnerForClient(client)
                        : findCurrentManagerForClient(client),
                )
            }

            const currentManager = await managerAuthorizationByIdentity.get(identityKey)
            if (!clients.has(client)) continue
            const stillAllowed = client.coOwnerArea
                ? Boolean(currentManager && resolveManagementAccess({
                    role: "co_owner",
                    coOwnerRestrictions: currentManager.coOwnerRestrictions || [],
                }, { area: client.coOwnerArea }))
                : currentManager?.permissions?.includes(client.managerPermission)
            if (!stillAllowed) {
                try {
                    client.res.end()
                } catch (err) {
                    console.error("[SSE] Failed to close unauthorized Manager stream:", err.message)
                }
                removeClient(client)
                continue
            }
        }

        // Per-table isolation for customer streams: a diner only receives events
        // for their own table. Staff channels (kitchen/bar/waitstaff/owner) are
        // business-wide and skip this. Falls open if either side lacks a servicePointId
        // (e.g. a non-table-specific event) so nothing legitimate is dropped.
        if (CUSTOMER_ROLES.has(client.role) && msgTableId && client.servicePointId && msgTableId !== client.servicePointId) {
            continue
        }

        try {
            const clientPayload = client.managerPermission === PERMISSIONS.DASHBOARD_VIEW
                ? { invalidated: true }
                : payload
            const data = `event: ${event}\ndata: ${JSON.stringify(clientPayload)}\n\n`
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

// ── Local delivery plus Redis cross-instance fan-out ─────────────────────────
/**
 * The single public API for emitting realtime events from business logic.
 *
 * In production (REDIS_URL set):
 *   Delivers to this instance immediately, then publishes a canonical JSON message
 *   to the shared Redis channel for every other subscribed instance.
 *
 * In local dev (REDIS_URL not set, redisPub === null):
 *   The direct in-process delivery preserves the existing single-process localhost
 *   experience with no extra setup required.
 *
 * @param {string}            event        SSE event name, e.g. "order_created"
 * @param {string}            businessId   Business scope
 * @param {string[]|null}     targets      Role whitelist, e.g. ["kitchen"], or null for all
 * @param {object}            payload      Data forwarded verbatim to the browser
 */
export async function publishEvent(event, businessId, targets, payload) {
    const msg = {
        event,
        businessId,
        targets: targets ?? null,
        payload,
        originInstanceId: REALTIME_INSTANCE_ID,
    }

    // Same-instance delivery is the latency and availability path. Redis is
    // still used below to fan the event out to every other API instance.
    await broadcastLocal(msg)

    if (!redisPub) {
        // Local dev: the event has already been delivered in-process.
        console.log(`[RealtimeBus] (local fallback) publishEvent event=${event} businessId=${businessId}`)
        return
    }

    try {
        await redisPub.publish(REDIS_CHANNEL, JSON.stringify(msg))
        console.log(
            `[RealtimeBus] ✅ Published event=${event} businessId=${businessId} targets=${JSON.stringify(targets ?? "all")}`
        )
    } catch (err) {
        console.error("[RealtimeBus] ❌ Redis PUBLISH failed; local clients were still updated:", err.message)
        // Local clients were already updated before the cross-instance publish.
    }
}

/** Disconnect a Manager's SSE streams on every app instance. */
export async function publishManagerAccessRevocation({ businessId, staffObjectId, staffId }) {
    return publishEvent(
        MANAGER_ACCESS_REVOKED_EVENT,
        businessId,
        null,
        {
            staffObjectId: staffObjectId ? String(staffObjectId) : null,
            staffId: staffId || null,
        },
    )
}

/** Disconnect a Co-Owner's management SSE streams on every app instance. */
export async function publishManagementAccessRevocation({ businessId, staffObjectId, staffId }) {
    return publishEvent(
        MANAGEMENT_ACCESS_REVOKED_EVENT,
        businessId,
        null,
        {
            staffObjectId: staffObjectId ? String(staffObjectId) : null,
            staffId: staffId || null,
        },
    )
}
