import WaiterCall from "../models/WaiterCall.js"
import { publishEvent } from "../utils/sseManager.js"

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
    const waiterId = getWaiterId(req) // can be empty for customer calls (that’s fine)
    const { tableNumber, reason = "", note = "", restaurantId } = req.body || {}

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" })
    }

    if (!tableNumber || !String(tableNumber).trim()) {
      return res.status(400).json({ error: "tableNumber is required" })
    }

    // OPTIONAL anti-spam: don’t allow multiple pending calls for same table
    const existingPending = await WaiterCall.findOne({
      restaurantId,
      tableNumber: String(tableNumber).trim(),
      status: "pending",
    }).lean()

    if (existingPending) {
      return res.status(200).json({
        success: true,
        call: existingPending,
        message: "Call already pending for this table",
      })
    }

    const call = await WaiterCall.create({
      restaurantId,
      tableNumber: String(tableNumber).trim(),
      reason: String(reason || "").trim(),
      note: String(note || "").trim(),
      status: "pending",
      createdBy: waiterId || null, // usually null because customer triggers it
    })

    await publishEvent("waiter_call_created", restaurantId, ["waiter"], { call })

    return res.status(201).json({ success: true, call })
  } catch (err) {
    console.error("[createWaiterCall]", err)
    return res.status(500).json({ error: "Failed to create waiter call" })
  }
}

export async function listWaiterCalls(req, res) {
  try {
    const { status = "active", restaurantId } = req.query

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" })
    }

    // status:
    // - "active" => pending + acknowledged
    // - "pending" | "acknowledged" | "resolved"

    const filter = { restaurantId }
    if (status === "active") {
      filter.status = { $in: ["pending", "acknowledged"] }
    } else if (["pending", "acknowledged", "resolved"].includes(String(status))) {
      filter.status = String(status)
    }

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
    const waiterId = getWaiterId(req)
    if (!waiterId) return res.status(400).json({ error: "Missing X-WAITER-ID header" })

    const { id } = req.params
    const { restaurantId } = req.body

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" })
    }

    const now = new Date()

    const claimed = await WaiterCall.findOneAndUpdate(
      {
        _id: id,
        restaurantId,
        status: "pending",
        claimedBy: null,
      },
      {
        $set: {
          status: "acknowledged",
          claimedBy: waiterId,
          claimedAt: now,
        },
      },
      { new: true },
    ).lean()

    if (!claimed) {
      // either not found, or already claimed
      const current = await WaiterCall.findOne({ _id: id, restaurantId }).lean()
      if (!current) return res.status(404).json({ error: "Call not found" })

      return res.status(409).json({
        error: "Call already claimed",
        call: current,
      })
    }

    await publishEvent("waiter_call_updated", restaurantId, ["waiter"], { call: claimed })

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
    const waiterId = getWaiterId(req)
    if (!waiterId) return res.status(400).json({ error: "Missing X-WAITER-ID header" })

    const { id } = req.params
    const { restaurantId } = req.body

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" })
    }

    const now = new Date()

    const updated = await WaiterCall.findOneAndUpdate(
      {
        _id: id,
        restaurantId,
        status: { $in: ["pending", "acknowledged"] },
        // Only claimer can resolve; if still pending, allow resolver to resolve only if they claim first
        $or: [{ claimedBy: waiterId }, { claimedBy: null, status: "pending" }],
      },
      {
        $set: {
          status: "resolved",
          resolvedBy: waiterId,
          resolvedAt: now,
          // If it was pending and resolved directly, mark who handled it
          claimedBy: waiterId,
          claimedAt: now,
        },
      },
      { new: true },
    ).lean()

    if (!updated) {
      const current = await WaiterCall.findOne({ _id: id, restaurantId }).lean()
      if (!current) return res.status(404).json({ error: "Call not found" })

      // someone else owns it
      return res.status(409).json({
        error: "Call is owned by another waiter/device",
        call: current,
      })
    }

    await publishEvent("waiter_call_updated", restaurantId, ["waiter"], { call: updated })

    return res.json({ success: true, call: updated })
  } catch (err) {
    console.error("[resolveWaiterCall]", err)
    return res.status(500).json({ error: "Failed to resolve call" })
  }
}
