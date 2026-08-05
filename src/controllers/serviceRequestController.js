import ServiceRequest from "../models/ServiceRequest.js"
import ServicePoint from "../models/ServicePoint.js"
import GuestSession from "../models/GuestSession.js"
import Business from "../models/Business.js"
import { publishEvent } from "../utils/sseManager.js"
import { DateTime } from "luxon"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"
import { normalizeFoodServiceRequestCategory } from "../services/serviceRequestClassificationService.js"
import {
  buildActiveServiceRequestLocationScope,
  getTrustedTableServicePointId,
} from "../services/serviceRequestScopeService.js"

async function expireStaleCalls(businessId) {
  const now = new Date()
  await ServiceRequest.updateMany(
    {
      businessId,
      module: "foodService",
      status: "pending",
      pendingExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: "missed",
        missedAt: now,
      },
    }
  )
}

/**
 * Resolve the businessId for a waiter-call request from a TRUSTED source:
 *   - an authenticated staff session, or
 *   - a valid (non-expired) table-session token presented by a customer device.
 * Never from a client-supplied businessId. Returns { businessId } or { error, status }.
 */
async function resolveCallBusinessId(req, token) {
  if (req.session?.user?.businessId) {
    return {
      businessId: req.session.user.businessId,
      contextType: "public",
      guestSessionId: null,
      servicePointId: null,
    }
  }
  if (!token) {
    return { error: "Missing table session token", status: 401 }
  }
  const ts = await GuestSession.findOne({ token }).lean()
  if (!ts || !ts.expiresAt || ts.expiresAt < new Date()) {
    return { error: "Invalid or expired table session", status: 403 }
  }
  return {
    businessId: ts.businessId,
    contextType: "table_session",
    guestSessionId: String(ts._id),
    servicePointId: ts.servicePointId,
  }
}

const BUSINESS_TZ = process.env.BUSINESS_TZ || "Europe/Malta"
const ROLLOVER_HOUR = Number(process.env.BUSINESS_DAY_ROLLOVER_HOUR || 2)

function getBusinessDayRange() {
  const now = DateTime.now().setZone(BUSINESS_TZ)
  const isBeforeRollover = now.hour < ROLLOVER_HOUR
  const baseDay = isBeforeRollover ? now.minus({ days: 1 }) : now

  const start = baseDay
    .startOf("day")
    .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })

  const end = start.plus({ days: 1 })

  return {
    startJS: start.toJSDate(),
    endJS: end.toJSDate(),
  }
}

/**
 * Expects a stable per-device waiter id in header:
 *   X-STAFF-ID: <uuid>
 */
function getWaiterId(req) {
  return String(req.header("X-STAFF-ID") || "").trim()
}

function getRelativeTime(date) {
  const ms = Date.now() - new Date(date).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h`
}

export async function createWaiterCall(req, res) {
  try {
    const staffId = getWaiterId(req) // can be empty for customer calls (that's fine)
    const { servicePointId = "", servicePointLabel = "", servicePointQrCode = "", reason = "", note = "", userDeviceId = "", token } = req.body || {}

    // businessId comes from the staff session or a valid table token — never the body.
    const resolved = await resolveCallBusinessId(req, token)
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error })
    }
    const businessId = resolved.businessId
    const business = await Business.findOne({ businessId }).lean()
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }
    const enabledModules =
      resolveBusinessCapabilities(business).visibleModules
    if (!enabledModules.includes("foodService")) {
      return res.status(403).json({
        error: "Food-service requests are not enabled for this business",
      })
    }

    if (!servicePointLabel || !String(servicePointLabel).trim()) {
      return res.status(400).json({ error: "servicePointLabel is required" })
    }

    // Lazy expiration
    await expireStaleCalls(businessId)
    const now = new Date()

    // Resolve the canonical service point before checking for an active request.
    // servicePointLabel is display data and can change independently of identity.
    const requestedTableLabel = String(servicePointLabel).trim()
    let finalTableLabel = String(servicePointLabel).trim()
    let finalTableCode = String(servicePointQrCode).trim()
    let finalServicePointId =
      resolved.servicePointId || String(servicePointId).trim() || null

    if (finalServicePointId || !finalTableLabel || !finalTableCode) {
      const spCondition = finalServicePointId
        ? { servicePointId: finalServicePointId }
        : requestedTableLabel.startsWith("sp_")
          ? { servicePointId: servicePointLabel }
          : { _id: servicePointLabel }

      const sp = await ServicePoint.findOne({
        businessId,
        ...spCondition
      }).lean()

      if (sp) {
        finalServicePointId = sp.servicePointId
        finalTableLabel = sp.label || finalTableLabel
        finalTableCode = sp.code || finalTableCode
      }
      if (!sp && finalServicePointId) {
        return res.status(400).json({ error: "A valid servicePointId is required" })
      }
    }

    const activeLocationScope = buildActiveServiceRequestLocationScope({
      servicePointId: finalServicePointId,
    })
    if (!activeLocationScope) {
      return res.status(400).json({ error: "servicePointId is required" })
    }

    // Sequential retries return the existing canonical service-point request.
    const existingActiveCall = await ServiceRequest.findOne({
      businessId,
      module: "foodService",
      $and: [
        activeLocationScope,
        {
          $or: [
            { status: "acknowledged" },
            { status: "pending", pendingExpiresAt: { $gt: now } },
          ],
        },
      ],
    }).lean()

    if (existingActiveCall) {
      return res.status(200).json({
        success: true,
        call: existingActiveCall,
        message: "A waiter has already been requested for this service point.",
      })
    }

    const call = await ServiceRequest.create({
      businessId,
      module: "foodService",
      contextType: resolved.contextType,
      guestSessionId: resolved.guestSessionId,
      servicePointId: finalServicePointId,
      servicePointLabel: finalTableLabel,
      servicePointQrCode: finalTableCode,
      userDeviceId: userDeviceId ? String(userDeviceId).trim() : null,
      reason: String(reason || "").trim(),
      requestCategory:
        normalizeFoodServiceRequestCategory(reason),
      note: String(note || "").trim(),
      status: "pending",
      createdBy: staffId || null, // usually null because customer triggers it
      pendingExpiresAt: new Date(now.getTime() + 3 * 60 * 1000),
    })

    // Notify staff and the customer's table stream (per-table scoped). The latter
    // lets other devices at the same table reflect the new call in real time.
    await publishEvent("waiter_call_created", businessId, ["waiter", "table", "anon"], { call })

    return res.status(201).json({ success: true, call })
  } catch (err) {
    console.error("[createWaiterCall]", err)
    return res.status(500).json({ error: "Failed to create waiter call" })
  }
}

export async function listWaiterCalls(req, res) {
  try {
    const { status = "active", token } = req.query

    // businessId comes from the staff session or a valid table token — never the query.
    const resolved = await resolveCallBusinessId(req, token)
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error })
    }
    const businessId = resolved.businessId

    // Lazy expiration before reading
    await expireStaleCalls(businessId)

    // status:
    // - "active" => pending + acknowledged
    // - "pending" | "acknowledged" | "resolved" | "missed" | "all"

    const filter = { businessId, module: "foodService" }
    const trustedTableServicePointId = getTrustedTableServicePointId(resolved)
    if (resolved.contextType === "table_session") {
      if (!trustedTableServicePointId) {
        return res.status(403).json({
          error: "Table session is missing service point scope",
        })
      }

      // A table token must never list another service point's requests.
      filter.servicePointId = trustedTableServicePointId
    }

    if (status === "active") {
      filter.status = { $in: ["pending", "acknowledged"] }
    } else if (["pending", "acknowledged", "resolved", "missed"].includes(String(status))) {
      filter.status = String(status)
    }
    // if status === "all", we don't set filter.status so it fetches everything

    const { startJS, endJS } = getBusinessDayRange()
    filter.createdAt = { $gte: startJS, $lt: endJS }

    const calls = await ServiceRequest.find(filter, {
      __v: 0,
    })
      .sort({ createdAt: -1 })
      .lean()

    return res.json({ calls })
  } catch (err) {
    console.error("[listWaiterCalls]", err)
    return res.status(500).json({ error: "Failed to fetch waiter calls" })
  }
}

/**
 * Atomic claim: only ONE waiter/device can claim a pending call.
 * If already claimed, returns 409.
 */
export async function claimWaiterCall(req, res) {
  try {
    const staffName = req.session?.user?.name || "Staff Member"
    const staffId = req.session?.user?.staffId || req.session?.user?.id

    if (!staffId) {
      return res.status(401).json({ error: "Unauthorized: Missing staff session" })
    }

    const { id } = req.params
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const now = new Date()

    const claimed = await ServiceRequest.findOneAndUpdate(
      {
        _id: id,
        businessId,
        module: "foodService",
        status: "pending",
        claimedBy: null,
      },
      {
        $set: {
          status: "acknowledged",
          claimedBy: staffId,
          claimedAt: now,
          acknowledgedAt: now,
          acknowledgedByStaffId: staffId,
          acknowledgedByName: staffName,
        },
      },
      { new: true },
    ).lean()

    if (!claimed) {
      // either not found, or already claimed
      const current = await ServiceRequest.findOne({
        _id: id,
        businessId,
        module: "foodService",
      }).lean()
      if (!current) return res.status(404).json({ error: "Call not found" })

      return res.status(409).json({
        error: "Call already claimed",
        call: current,
      })
    }

    await publishEvent("waiter_call_updated", businessId, ["waiter", "table", "anon"], { call: claimed })

    return res.json({ success: true, call: claimed })
  } catch (err) {
    console.error("[claimWaiterCall]", err)
    return res.status(500).json({ error: "Failed to claim call" })
  }
}

/**
 * Resolve: only the claimer can resolve (multi-waiter safe).
 */
export async function resolveWaiterCall(req, res) {
  try {
    const staffName = req.session?.user?.name || "Staff Member"
    const staffId = req.session?.user?.staffId || req.session?.user?.id

    if (!staffId) {
      return res.status(401).json({ error: "Unauthorized: Missing staff session" })
    }

    const { id } = req.params
    const businessId = req.session?.user?.businessId
    const role = req.session?.user?.role || "waiter"
    const isManagerOrOwner = ["manager", "owner", "co_owner", "primary_owner"].includes(role)

    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const now = new Date()

    // Query to find the call and update it if allowed
    const query = {
      _id: id,
      businessId,
      module: "foodService",
      status: { $in: ["pending", "acknowledged"] },
    }

    if (!isManagerOrOwner) {
      // Waiters can only resolve calls they have claimed.
      query.claimedBy = staffId
    }

    const updated = await ServiceRequest.findOneAndUpdate(
      query,
      {
        $set: {
          status: "resolved",
          resolvedBy: staffId, // using staffId instead of device header
          resolvedByStaffId: staffId,
          resolvedByName: staffName,
          resolvedAt: now,
          // If it was pending and resolved directly, mark who handled it
          claimedBy: staffId,
          claimedAt: now,
        },
      },
      { new: true },
    ).lean()

    if (!updated) {
      const current = await ServiceRequest.findOne({
        _id: id,
        businessId,
        module: "foodService",
      }).lean()
      if (!current) return res.status(404).json({ error: "Call not found" })

      // someone else owns it
      return res.status(409).json({
        error: "Call is owned by another waiter/device",
        call: current,
      })
    }

    await publishEvent("waiter_call_updated", businessId, ["waiter", "table", "anon"], { call: updated })

    return res.json({ success: true, call: updated })
  } catch (err) {
    console.error("[resolveWaiterCall]", err)
    return res.status(500).json({ error: "Failed to resolve call" })
  }
}
