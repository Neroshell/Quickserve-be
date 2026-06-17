import express from "express"
import crypto from "crypto"
import TableSession from "../models/TableSession.js"
import Business from "../models/Business.js"
import ServicePoint from "../models/ServicePoint.js"

const router = express.Router()

function randomToken() {
  return crypto.randomBytes(24).toString("base64url")
}

/**
 * @openapi
 * /table-session/start:
 *   post:
 *     summary: Initialize a new Table Session from a QR code scan
 *     tags:
 *       - Table Session
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - servicePointId
 *             properties:
 *               businessId:
 *                 type: string
 *               restaurantId:
 *                 type: string
 *                 description: Legacy restaurant ID (backward compatibility)
 *               servicePointId:
 *                 type: string
 *               tableId:
 *                 type: string
 *                 description: Legacy table ID (backward compatibility)
 *     responses:
 *       200:
 *         description: Table session started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 businessId:
 *                   type: string
 *                 servicePointId:
 *                   type: string
 *                 label:
 *                   type: string
 */
router.post("/start", async (req, res) => {
  try {
    // Accept servicePointId as the preferred field; fall back to tableId or restaurantId patterns
    const businessId = req.body.businessId || req.body.restaurantId
    const tableId = req.body.servicePointId || req.body.tableId

    if (!businessId || !tableId) {
      return res.status(400).json({ error: "Missing businessId or servicePointId" })
    }

    // 1. Validate business exists
    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    let label = null
    let code = null
    
    // 2. If this is a managed service point (sp_* prefix), validate it
    if (tableId.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: tableId, businessId })
      if (!sp) {
        return res.status(404).json({ error: "Service point not found" })
      }
      if (!sp.isActive) {
        return res.status(400).json({
          error: `This ${sp.servicePointType === "room" ? "room" : "table"} is currently not in service.`,
        })
      }
      label = sp.label
      code = sp.code
    }

    // 3. Create session
    const token = randomToken()
    const fallbackMinutes = 120
    const expiryMinutes =
      business?.tablePreferences?.sessionExpiryMinutes ||
      business?.settings?.service?.sessionExpiryMinutes ||
      fallbackMinutes
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000)

    await TableSession.create({
      businessId,
      tableId,   // stores servicePointId — backward compat field name
      token,
      expiresAt,
      boundSessionId: null,
    })

    return res.json({
      token,
      expiresAt,
      businessId,
      tableId,          // kept for legacy consumers
      servicePointId: tableId,  // also expose as servicePointId
      label,
      code,
    })
  } catch (err) {
    console.error("Table session start error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

export default router
