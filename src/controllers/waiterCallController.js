import WaiterCall from "../models/WaiterCall.js"
import ServicePoint from "../models/ServicePoint.js"
import { publishEvent } from "../utils/sseManager.js"
import { DateTime } from "luxon"

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
 *   X-WAITER-ID: <uuid>
 */
function getWaiterId(req) {
  return String(req.header("X-WAITER-ID") || "").trim()
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
    const waiterId = getWaiterId(req) // can be empty for customer calls (that's fine)
    const { tableNumber, tableLabel = "", tableCode = "", reason = "", note = "", userDeviceId = "" } = req.body || {}
    const businessId = req.session?.user?.businessId || req.body?.businessId || req.body?.restaurantId

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    if (!tableNumber || !String(tableNumber).trim()) {
      return res.status(400).json({ error: "tableNumber is required" })
    }

    // Table-level anti-spam: only allow one active call per table
    const existingActiveCall = await WaiterCall.findOne({
      businessId,
      tableNumber: String(tableNumber).trim(),
      status: { $in: ["pending", "acknowledged"] },
    }).lean()

    if (existingActiveCall) {
      return res.status(200).json({
        success: true,
        call: existingActiveCall,
        message: "A waiter has already been requested for this table.",
      })
    }

    // Resolve Service Point dynamically on creation to store labels statically
    let finalTableLabel = String(tableLabel).trim()
    let finalTableCode = String(tableCode).trim()
    
    if (!finalTableLabel || !finalTableCode) {
      const spCondition = tableNumber.startsWith('sp_') 
        ? { servicePointId: tableNumber } 
        : { _id: tableNumber };

      const sp = await ServicePoint.findOne({ 
        businessId, 
        ...spCondition
      }).lean()
      
      if (sp) {
        finalTableLabel = sp.label || finalTableLabel
        finalTableCode = sp.code || finalTableCode
      }
    }

    const call = await WaiterCall.create({
      businessId,
      tableNumber: String(tableNumber).trim(),
      tableLabel: finalTableLabel,
      tableCode: finalTableCode,
      userDeviceId: userDeviceId ? String(userDeviceId).trim() : null,
      reason: String(reason || "").trim(),
      note: String(note || "").trim(),
      status: "pending",
      createdBy: waiterId || null, // usually null because customer triggers it
    })

    await publishEvent("waiter_call_created", businessId, ["waiter"], { call })

    return res.status(201).json({ success: true, call })
  } catch (err) {
    console.error("[createWaiterCall]", err)
    return res.status(500).json({ error: "Failed to create waiter call" })
  }
}

export async function listWaiterCalls(req, res) {
  try {
    const { status = "active" } = req.query
    const businessId = req.session?.user?.businessId || req.query.businessId || req.query.restaurantId

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    // status:
    // - "active" => pending + acknowledged
    // - "pending" | "acknowledged" | "resolved"

    const filter = { businessId }
    if (status === "active") {
      filter.status = { $in: ["pending", "acknowledged"] }
    } else if (["pending", "acknowledged", "resolved"].includes(String(status))) {
      filter.status = String(status)
    }

    const { startJS, endJS } = getBusinessDayRange()
    filter.createdAt = { $gte: startJS, $lt: endJS }

    const calls = await WaiterCall.find(filter, {
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
    const businessId = req.session?.user?.businessId || req.body.businessId || req.body.restaurantId

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const now = new Date()

    const claimed = await WaiterCall.findOneAndUpdate(
      {
        _id: id,
        businessId,
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
      const current = await WaiterCall.findOne({ _id: id, businessId }).lean()
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
    const businessId = req.session?.user?.businessId || req.body.businessId || req.body.restaurantId

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const now = new Date()

    const updated = await WaiterCall.findOneAndUpdate(
      {
        _id: id,
        businessId,
        status: { $in: ["pending", "acknowledged"] },
        // Only claimer can resolve; if still pending, allow resolver to resolve only if they claim first
        $or: [{ claimedBy: staffId }, { claimedBy: null, status: "pending" }],
      },
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
      const current = await WaiterCall.findOne({ _id: id, businessId }).lean()
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
