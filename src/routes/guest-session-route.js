import express from "express"
import rateLimit from "express-rate-limit"
import crypto from "crypto"
import GuestSession from "../models/GuestSession.js"
import Business from "../models/Business.js"
import ServicePoint from "../models/ServicePoint.js"

const router = express.Router()

// Cap table-session creation per IP to prevent scripted session spam / DB bloat.
const tableSessionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
})

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
 *               businessId:
 *                 type: string
 *                 description: Legacy restaurant ID (backward compatibility)
 *               servicePointId:
 *                 type: string
 *               servicePointId:
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
router.post("/start", tableSessionLimiter, async (req, res) => {
  try {
    const businessId = req.body.businessId
    const servicePointId = req.body.servicePointId

    if (!businessId || !servicePointId) {
      return res.status(400).json({ error: "Missing businessId or servicePointId" })
    }

    // 1. Validate business exists
    const business = await Business.findOne({ businessId })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    let label = null
    let code = null
    
    // 2. If this is a managed service point (sp_* prefix), validate it
    if (servicePointId.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: servicePointId, businessId })
      if (!sp) {
        return res.status(404).json({ error: "Service point not found" })
      }
      if (!sp.isActive) {
        return res.status(400).json({
          error: "This service point is currently not in service.",
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

    await GuestSession.create({
      businessId,
      servicePointId,   // stores servicePointId — backward compat field name
      token,
      expiresAt,
      boundSessionId: null,
    })

    return res.json({
      token,
      expiresAt,
      businessId,
      servicePointId,
      label,
      code,
    })
  } catch (err) {
    console.error("Table session start error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

export default router
