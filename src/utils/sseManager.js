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
import Business from "../models/Business.js"
import Staff from "../models/Staff.js"
import {
    isStaffSessionUser,
    resolveCurrentCoOwner,
    resolveCurrentManager,
    resolveCurrentOperationalStaff,
    resolveCurrentStaff,
} from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"
import {
    MANAGEMENT_AREA_BY_PERMISSION,
    resolveManagementAccess,
} from "../constants/managementAccess.js"
import { resolveNotificationAccessContext } from "../services/notificationReadService.js"
import {
    isCurrentCustomerVisitStillActive,
    resolveCurrentCustomerVisit,
} from "../services/customerOrderAccessService.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"

// Which SSE channel(s) a given authenticated staff role is allowed to subscribe to.
// The channel is derived from the session role — NOT the client-supplied query —
// so a kitchen/bar staffer can't spoof role=waiter to read the full order stream.
// (Staff role enum is waiter/kitchen/manager/bartender/co_owner/owner; the SSE
// channel names are kitchen/bar/waiter/owner — note bartender → "bar".)
const SSE_CHANNELS_BY_ROLE = {
    kitchen: ["kitchen"],
    bartender: ["bar"],
    waiter: ["waiter", "reservations"],
    housekeeping: ["housekeeping"],
    manager: ["kitchen", "bar", "waiter", "owner", "reservations", "housekeeping"],
    owner: ["kitchen", "bar", "waiter", "owner", "reservations", "housekeeping"],
    co_owner: ["kitchen", "bar", "waiter", "owner", "reservations", "housekeeping"],
    admin: ["kitchen", "bar", "waiter", "owner", "reservations", "housekeeping"],
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
        PERMISSIONS.SERVICE_POINTS_VIEW,
        PERMISSIONS.STAFF_VIEW,
    ]),
    reservations: new Set([PERMISSIONS.RESERVATIONS_VIEW]),
    housekeeping: new Set([PERMISSIONS.HOUSEKEEPING_VIEW]),
}

const MANAGER_ACCESS_REVOKED_EVENT = "__manager_access_revoked"
const STAFF_ACCESS_REVOKED_EVENT = "__staff_access_revoked"
export const CO_OWNER_ACCESS_CHANGED_EVENT = "co_owner_access_changed"
export const NOTIFICATION_CHANGED_EVENT = "notification_changed"
export const SERVICE_POINTS_CHANGED_EVENT = "service_points_changed"
export const HOUSEKEEPING_CHANGED_EVENT = "housekeeping_changed"

function managerPermissionAllowsEvent(permission, event) {
    if (permission === PERMISSIONS.DASHBOARD_VIEW) return true
    if (permission === PERMISSIONS.ORDERS_VIEW) return event.startsWith("order_")
    if (permission === PERMISSIONS.SERVICE_POINTS_VIEW) return event === SERVICE_POINTS_CHANGED_EVENT
    if (permission === PERMISSIONS.STAFF_VIEW) return event.startsWith("staff_")
    if (permission === PERMISSIONS.RESERVATIONS_VIEW) return event.startsWith("reservation_")
    if (permission === PERMISSIONS.HOUSEKEEPING_VIEW) return event === HOUSEKEEPING_CHANGED_EVENT
    return false
}

// ── Local client registry ────────────────────────────────────────────────────
const clients = new Set()

function normalizedAuthVersion(value) {
    const version = Number(value)
    return Number.isSafeInteger(version) && version >= 0 ? version : 0
}

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
        const staff = await Staff.findOne({
            ...identityFilter,
            businessId: client.businessId,
            role: "manager",
            accountStatus: "active",
        })
            .select("permissions authVersion")
            .lean()
        return staff && normalizedAuthVersion(staff.authVersion) === normalizedAuthVersion(client.managementAuthVersion)
            ? staff
            : null
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
        const staff = await Staff.findOne({
            ...identityFilter,
            businessId: client.businessId,
            role: "co_owner",
            accountStatus: "active",
        })
            .select("coOwnerRestrictions authVersion")
            .lean()
        return staff && normalizedAuthVersion(staff.authVersion) === normalizedAuthVersion(client.managementAuthVersion)
            ? staff
            : null
    } catch (err) {
        console.error("[SSE] Failed to revalidate Co-Owner stream:", err.message)
        return null
    }
}

async function findCurrentOperationalStaffForClient(client) {
    const identityFilter = client.operationalIdentity?.staffObjectId
        ? { _id: client.operationalIdentity.staffObjectId }
        : { staffId: client.operationalIdentity?.staffId }
    try {
        const staff = await Staff.findOne({
            ...identityFilter,
            businessId: client.businessId,
            role: client.operationalRole,
            accountStatus: "active",
        }).select("permissions authVersion").lean()
        return staff && normalizedAuthVersion(staff.authVersion) === normalizedAuthVersion(client.operationalAuthVersion)
            ? staff
            : null
    } catch (error) {
        console.error("[SSE] Failed to revalidate operational stream:", error.message)
        return null
    }
}

async function businessHasLodgingCapability(businessId) {
    try {
        const business = await Business.findOne({ businessId }).select("businessType modules").lean()
        return Boolean(business && resolveBusinessCapabilities(business).visibleModules.includes("lodging"))
    } catch (error) {
        console.error("[SSE] Failed to revalidate lodging capability:", error.message)
        return false
    }
}

// ── SSE HTTP handler ─────────────────────────────────────────────────────────
function notificationRecipientMatches(client, recipientTargets) {
    if (!Array.isArray(recipientTargets) || recipientTargets.length === 0) return false
    return recipientTargets.some((target) => (
        target?.recipientKind === client.notificationIdentity?.recipientKind &&
        String(target?.recipientId) === String(client.notificationIdentity?.recipientId)
    ))
}

async function revalidateNotificationClient(client, access = {}) {
    try {
        if (client.notificationRole === "owner") {
            return Boolean(await Business.exists({
                _id: client.notificationIdentity?.recipientId,
                businessId: client.businessId,
                ownerStatus: "active",
            }))
        }

        const staff = await Staff.findOne({
            _id: client.notificationIdentity?.recipientId,
            businessId: client.businessId,
            role: client.notificationRole,
            accountStatus: "active",
        })
            .select("permissions coOwnerRestrictions authVersion")
            .lean()
        if (!staff) return false
        if (
            normalizedAuthVersion(staff.authVersion) !==
            normalizedAuthVersion(client.notificationAuthVersion)
        ) return false

        if (!access?.area) return true
        if (client.notificationRole === "co_owner") {
            return resolveManagementAccess({
                role: "co_owner",
                coOwnerRestrictions: staff.coOwnerRestrictions || [],
            }, { area: access.area })
        }
        if (client.notificationRole === "manager") {
            if (!access.permission) return false
            return resolveManagementAccess({
                role: "manager",
                permissions: staff.permissions || [],
            }, {
                area: access.area,
                managerPermissions: [access.permission],
            })
        }
        return false
    } catch (error) {
        console.error("[SSE] Failed to revalidate notification stream:", error.message)
        return false
    }
}

function configureStreamResponse(res) {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()
}

/** Authenticated, recipient-scoped, content-free notification invalidation stream. */
export async function notificationSseHandler(req, res, {
    resolveAccess = resolveNotificationAccessContext,
    revalidateClient = revalidateNotificationClient,
} = {}) {
    let context
    try {
        context = await resolveAccess(req)
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 403
        return res.status(statusCode).end(statusCode === 401 ? "Unauthorized" : "Forbidden")
    }

    configureStreamResponse(res)
    const client = {
        res,
        role: "notifications",
        businessId: context.businessId,
        notificationRole: context.user.role,
        notificationIdentity: {
            recipientKind: context.recipientKind,
            recipientId: String(context.recipientId),
        },
        notificationAuthVersion: context.staffAuthVersion,
        notificationRevalidator: revalidateClient,
    }
    addClient(client)
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now() })}\n\n`)

    const keepAlive = setInterval(async () => {
        try {
            const stillAllowed = await revalidateClient(client)
            if (!clients.has(client)) return
            if (!stillAllowed) {
                res.end()
                removeClient(client)
                return
            }
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`)
        } catch (error) {
            console.error("[SSE] Notification heartbeat failed:", error.message)
            try {
                res.end()
            } catch {}
            removeClient(client)
        }
    }, 25_000)
    keepAlive.unref?.()
    client.keepAlive = keepAlive

    req.on("close", () => removeClient(client))
}

/**
 * Authenticated, recipient-scoped Co-Owner access invalidation stream.
 * Permission state is never sent over SSE; clients refetch /auth/me.
 */
export async function coOwnerAccessSseHandler(req, res, {
    resolveCoOwner = resolveCurrentCoOwner,
} = {}) {
    const businessId = req.session?.user?.businessId
    if (!businessId || req.session?.user?.role !== "co_owner") {
        return res.status(403).end("Forbidden")
    }

    const coOwner = await resolveCoOwner(req)
    if (!coOwner || coOwner.businessId !== businessId) {
        return res.status(403).end("Forbidden")
    }

    configureStreamResponse(res)
    const client = {
        res,
        role: "co_owner_access",
        businessId,
        managementIdentity: {
            staffObjectId: String(coOwner._id),
            staffId: coOwner.staffId,
        },
        managementAuthVersion: coOwner.authVersion,
        accessIdentity: {
            staffObjectId: String(coOwner._id),
            staffId: coOwner.staffId,
        },
    }
    addClient(client)
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now() })}\n\n`)

    const keepAlive = setInterval(async () => {
        try {
            const stillAllowed = await findCurrentCoOwnerForClient(client)
            if (!clients.has(client)) return
            if (!stillAllowed) {
                res.end()
                removeClient(client)
                return
            }
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`)
        } catch (error) {
            console.error("[SSE] Co-Owner access heartbeat failed:", error.message)
            removeClient(client)
        }
    }, 25_000)
    keepAlive.unref?.()
    client.keepAlive = keepAlive

    req.on("close", () => removeClient(client))
}

export async function sseHandler(req, res) {
    let role = req.query.role || "anon"
    const businessId = req.query.businessId || req.query.businessId
    const token = req.query.token
    const deviceSessionId = req.query.sessionId
    let managerPermission = null
    let managerIdentity = null
    let coOwnerArea = null
    let managementIdentity = null
    let operationalPermission = null
    let operationalIdentity = null
    let operationalRole = null
    let operationalAuthVersion = null
    let managementAuthVersion = null

    if (!businessId) {
        return res.status(400).end("Missing businessId")
    }

    // ── Authentication & Authorization ─────────────────────────────────────────
    let clientTableId = null
    let clientGuestSessionId = null
    if (role === "table" || role === "anon" || role === "customer") {
        const access = await resolveCurrentCustomerVisit({
            req,
            businessId,
            sessionId: deviceSessionId,
        })
        if (!access.guestSession) {
            return res.status(access.statusCode).end(access.message)
        }
        // Customer streams are pinned to one canonical visit and ServicePoint.
        // Device identity alone never selects or broadens live events.
        clientTableId = access.guestSession.servicePointId || null
        clientGuestSessionId = access.guestSessionId
    } else {
        // Staff roles (waiter, kitchen, bartender, owner, etc.)
        if (!req.session || !req.session.user) {
            return res.status(401).end("Unauthorized. Please log in.")
        }
        if (req.session.user.businessId !== businessId) {
            return res.status(403).end("Forbidden. businessId mismatch.")
        }

        let currentStaff = null
        if (isStaffSessionUser(req.session.user)) {
            try {
                currentStaff = await resolveCurrentStaff(req)
            } catch (error) {
                console.error("[SSE] Failed to verify current Staff session:", error.message)
                return res.status(500).end("Unable to verify session.")
            }
            if (!currentStaff) {
                return res.status(401).end("Session is no longer valid. Please log in again.")
            }
        }

        const currentRole = currentStaff?.role || req.session.user.role

        // Anti-spoofing: pin the channel to what this session role is allowed to
        // receive. A staffer cannot read another role's stream by changing ?role=.
        const allowedChannels = SSE_CHANNELS_BY_ROLE[currentRole] || []
        if (allowedChannels.length === 0) {
            return res.status(403).end("Forbidden. Role not permitted for live updates.")
        }
        if (!allowedChannels.includes(role)) {
            role = allowedChannels[0]
        }

        if (role === "housekeeping" && !await businessHasLodgingCapability(businessId)) {
            return res.status(403).end("Forbidden. Housekeeping is not enabled for this business.")
        }

        if (currentRole === "manager") {
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
            managementAuthVersion = manager.authVersion
        } else if (currentRole === "co_owner") {
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
            managementAuthVersion = coOwner.authVersion
        } else if (["waiter", "kitchen", "bartender", "housekeeping"].includes(currentRole)) {
            const staff = currentStaff || await resolveCurrentOperationalStaff(req)
            if (!staff) {
                return res.status(401).end("Session is no longer valid. Please log in again.")
            }
            if (
                currentRole === "housekeeping" &&
                !(staff.permissions || []).includes(PERMISSIONS.HOUSEKEEPING_VIEW)
            ) {
                return res.status(403).end("Forbidden. Housekeeping live-update permission denied.")
            }
            operationalPermission = currentRole === "housekeeping"
                ? PERMISSIONS.HOUSEKEEPING_VIEW
                : null
            operationalRole = staff.role
            operationalAuthVersion = staff.authVersion
            operationalIdentity = {
                staffObjectId: String(staff._id),
                staffId: staff.staffId,
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
        guestSessionId: clientGuestSessionId,
        deviceSessionId: deviceSessionId || null,
        guestSessionToken: clientGuestSessionId ? token : null,
        managerPermission,
        managerIdentity,
        coOwnerArea,
        managementIdentity,
        managementAuthVersion,
        operationalPermission,
        operationalIdentity,
        operationalRole,
        operationalAuthVersion,
    }

    addClient(client)

    // Initial heartbeat so the browser's EventSource opens immediately
    res.write(
        `event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now(), role, businessId })}\n\n`
    )

    // Keep-alive ping every 25 s (prevents idle disconnects through proxies/load balancers)
    const keepAlive = setInterval(async () => {
        try {
            if (CUSTOMER_ROLES.has(client.role)) {
                const stillAllowed = await isCurrentCustomerVisitStillActive({
                    guestSessionId: client.guestSessionId,
                    token: client.guestSessionToken,
                    businessId: client.businessId,
                    servicePointId: client.servicePointId,
                    sessionId: client.deviceSessionId,
                })
                if (!clients.has(client)) return
                if (!stillAllowed) {
                    res.end()
                    clearInterval(keepAlive)
                    removeClient(client)
                    return
                }
            }
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
            if (client.operationalIdentity) {
                const currentStaff = await findCurrentOperationalStaffForClient(client)
                if (!clients.has(client)) return
                if (
                    !currentStaff ||
                    (client.operationalPermission && !currentStaff.permissions?.includes(client.operationalPermission))
                ) {
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

function staffIdentityMatches(client, { staffObjectId, staffId }) {
    const identities = [
        client.managerIdentity,
        client.managementIdentity,
        client.operationalIdentity,
        client.accessIdentity,
    ].filter(Boolean)

    if (
        client.notificationIdentity?.recipientKind === "staff" &&
        client.notificationIdentity.recipientId
    ) {
        identities.push({ staffObjectId: client.notificationIdentity.recipientId })
    }

    return identities.some((identity) => (
        (staffObjectId && identity.staffObjectId === String(staffObjectId)) ||
        (staffId && identity.staffId === staffId)
    ))
}

/** Close every live stream for one Staff identity on this app instance. */
export function disconnectStaffClients({ businessId, staffObjectId, staffId }) {
    let disconnected = 0
    for (const client of [...clients]) {
        if (client.businessId !== businessId) continue
        if (!staffIdentityMatches(client, { staffObjectId, staffId })) continue

        try {
            client.res.end()
        } catch (error) {
            console.error("[SSE] Failed to close revoked Staff stream:", error.message)
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
        // The dedicated Co-Owner access stream must receive the invalidation
        // event so its UI can refetch /auth/me. Generic Staff revocation still
        // closes this stream through disconnectStaffClients.
        if (client.role === "co_owner_access") continue
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

function coOwnerAccessTargetMatches(client, target) {
    if (!target || !client.accessIdentity) return false
    return Boolean(
        (target.staffObjectId && client.accessIdentity.staffObjectId === String(target.staffObjectId)) ||
        (target.staffId && client.accessIdentity.staffId === target.staffId)
    )
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
    const {
        event,
        businessId,
        targets,
        payload,
        recipientTargets,
        notificationAccess,
        coOwnerAccessTarget,
    } = msg

    if (!event || !businessId) {
        console.warn("[SSE] broadcastLocal called with missing event or businessId — skipping", msg)
        return
    }

    // Internal control message distributed over the existing realtime bus.
    // It is consumed by every app instance and is never forwarded to clients.
    if (event === STAFF_ACCESS_REVOKED_EVENT) {
        disconnectStaffClients({
            businessId,
            staffObjectId: payload?.staffObjectId,
            staffId: payload?.staffId,
        })
        return
    }
    if (event === MANAGER_ACCESS_REVOKED_EVENT) {
        disconnectManagerClients({
            businessId,
            staffObjectId: payload?.staffObjectId,
            staffId: payload?.staffId,
        })
        return
    }
    if (event === CO_OWNER_ACCESS_CHANGED_EVENT) {
        disconnectManagementClients({
            businessId,
            staffObjectId: coOwnerAccessTarget?.staffObjectId,
            staffId: coOwnerAccessTarget?.staffId,
        })

        for (const client of clients) {
            if (
                client.role !== "co_owner_access" ||
                client.businessId !== businessId ||
                !coOwnerAccessTargetMatches(client, coOwnerAccessTarget)
            ) continue

            try {
                client.res.write(
                    `event: ${CO_OWNER_ACCESS_CHANGED_EVENT}\ndata: ${JSON.stringify({ invalidated: true })}\n\n`,
                )
            } catch (error) {
                console.error("[SSE] Co-Owner access invalidation write failed:", error.message)
                removeClient(client)
            }
        }
        return
    }

    // The table this event belongs to, if any. Orders and waiter calls carry the
    // identity used to scope customer streams below. Waiter calls use only the
    // canonical servicePointId; the order fallback remains unchanged.
    const msgTableId =
        payload?.servicePointId ||
        payload?.order?.servicePointId ||
        payload?.order?.servicePointLabel ||
        payload?.call?.servicePointId ||
        null
    const msgGuestSessionId =
        payload?.guestSessionId ||
        payload?.order?.guestSessionId ||
        payload?.call?.guestSessionId ||
        null

    let matched = 0
    const managerAuthorizationByIdentity = new Map()
    const operationalAuthorizationByIdentity = new Map()

    for (const client of clients) {
        // Business isolation — strict
        if (client.businessId !== businessId) continue

        // Role targeting — if targets is null/empty every role passes.
        // Dashboard roles (owner) bypass target filtering to receive all
        // staff-targeted operational events as invalidation signals.
        if (event === NOTIFICATION_CHANGED_EVENT) {
            if (client.role !== "notifications") continue
            if (!notificationRecipientMatches(client, recipientTargets)) continue

            const stillAllowed = await client.notificationRevalidator(client, notificationAccess)
            if (!clients.has(client)) continue
            if (!stillAllowed) {
                try {
                    client.res.end()
                } catch (error) {
                    console.error("[SSE] Failed to close unauthorized notification stream:", error.message)
                }
                removeClient(client)
                continue
            }

            try {
                client.res.write(
                    `event: ${NOTIFICATION_CHANGED_EVENT}\ndata: ${JSON.stringify({ invalidated: true })}\n\n`,
                )
                matched++
            } catch (error) {
                console.error("[SSE] Notification write failed, removing client:", error.message)
                removeClient(client)
            }
            continue
        }

        // Notification clients never receive operational event payloads.
        if (client.role === "notifications") continue

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

        if (client.operationalIdentity) {
            const identityKey = `${client.businessId}:${client.operationalIdentity.staffObjectId || client.operationalIdentity.staffId || "unknown"}`
            if (!operationalAuthorizationByIdentity.has(identityKey)) {
                operationalAuthorizationByIdentity.set(
                    identityKey,
                    findCurrentOperationalStaffForClient(client),
                )
            }
            const currentStaff = await operationalAuthorizationByIdentity.get(identityKey)
            if (!clients.has(client)) continue
            if (
                !currentStaff ||
                (client.operationalPermission && !currentStaff.permissions?.includes(client.operationalPermission))
            ) {
                try { client.res.end() } catch {}
                removeClient(client)
                continue
            }
        }

        // Customer delivery fails closed unless both the canonical GuestSession
        // visit and ServicePoint match. Historical/device identity is never used
        // for live fan-out, including later visits at the same ServicePoint.
        if (CUSTOMER_ROLES.has(client.role)) {
            if (!msgGuestSessionId || msgGuestSessionId !== client.guestSessionId) continue
            if (!msgTableId || msgTableId !== client.servicePointId) continue
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
export async function publishEvent(event, businessId, targets, payload, internal = {}) {
    const msg = {
        event,
        businessId,
        targets: targets ?? null,
        payload,
        ...internal,
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

/**
 * Publish a content-free Service Points invalidation signal. The business ID
 * remains in the canonical realtime envelope; clients must refetch the
 * authoritative tenant-scoped HTTP resources instead of applying payload data.
 */
export async function publishServicePointsChanged({
    businessId,
    scope = "activity",
    publish = publishEvent,
}) {
    if (!businessId) return
    const safeScope = scope === "configuration" ? "configuration" : "activity"

    try {
        await publish(
            SERVICE_POINTS_CHANGED_EVENT,
            businessId,
            ["owner"],
            { invalidated: true, scope: safeScope },
        )
    } catch (error) {
        // MongoDB remains authoritative. Clients recover on reconnect/focus.
        console.error("[ServicePoints] Realtime invalidation failed:", error.message)
    }
}

/** Publish a tenant-scoped, content-free Housekeeping invalidation signal. */
export async function publishHousekeepingChanged({
    businessId,
    publish = publishEvent,
}) {
    if (!businessId) return
    try {
        await publish(
            HOUSEKEEPING_CHANGED_EVENT,
            businessId,
            ["housekeeping"],
            { invalidated: true },
        )
    } catch (error) {
        // MongoDB remains authoritative. Clients recover on reconnect/focus.
        console.error("[Housekeeping] Realtime invalidation failed:", error.message)
    }
}

/** Publish a recipient-scoped, content-free notification invalidation signal. */
export async function publishNotificationChanged({
    businessId,
    recipients,
    requiredAccessArea = null,
    requiredPermission = null,
}) {
    const recipientTargets = (Array.isArray(recipients) ? recipients : [])
        .map((recipient) => ({
            recipientKind: recipient?.recipientKind,
            recipientId: recipient?.recipientId ? String(recipient.recipientId) : "",
        }))
        .filter((recipient) => recipient.recipientKind && recipient.recipientId)
    if (!businessId || recipientTargets.length === 0) return

    try {
        await publishEvent(
            NOTIFICATION_CHANGED_EVENT,
            businessId,
            ["notifications"],
            { invalidated: true },
            {
                recipientTargets,
                notificationAccess: {
                    area: requiredAccessArea,
                    permission: requiredPermission,
                },
            },
        )
    } catch (error) {
        // MongoDB remains authoritative. Clients refetch on reconnect/focus.
        console.error("[Notifications] Realtime invalidation failed:", error.message)
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

/** Disconnect every current SSE stream for one revoked/version-changed Staff account. */
export async function publishStaffAccessRevocation({ businessId, staffObjectId, staffId }) {
    return publishEvent(
        STAFF_ACCESS_REVOKED_EVENT,
        businessId,
        null,
        {
            staffObjectId: staffObjectId ? String(staffObjectId) : null,
            staffId: staffId || null,
        },
    )
}

/** Invalidate one Co-Owner's auth state and close stale management streams. */
export async function publishCoOwnerAccessChanged({ businessId, staffObjectId, staffId }) {
    return publishEvent(
        CO_OWNER_ACCESS_CHANGED_EVENT,
        businessId,
        ["co_owner_access"],
        { invalidated: true },
        {
            coOwnerAccessTarget: {
                staffObjectId: staffObjectId ? String(staffObjectId) : null,
                staffId: staffId || null,
            },
        },
    )
}
