import express from "express"
import rateLimit from "express-rate-limit"
import crypto from "crypto"
import GuestSession from "../models/GuestSession.js"
import Business from "../models/Business.js"
import ServicePoint from "../models/ServicePoint.js"
import { isBusinessServable } from "../utils/restaurantOrderValidation.js"
import { startCustomerJourney } from "../services/customerJourneyService.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"
import { publishServicePointsChanged } from "../utils/sseManager.js"
import {
  normalizeServicePointQrCapabilityVersion,
  servicePointQrCapabilityMatches,
} from "../services/servicePointQrCapabilityService.js"

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
 *               - qrCapability
 *               - sessionId
 *             properties:
 *               businessId:
 *                 type: string
 *               servicePointId:
 *                 type: string
 *               qrCapability:
 *                 type: string
 *                 description: Signed, tenant- and ServicePoint-scoped QR capability
 *               sessionId:
 *                 type: string
 *                 description: Persistent device identity used for GuestSession binding
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
const INVALID_QR_RESPONSE = Object.freeze({
  error: "This QR code is invalid or no longer active.",
})

export async function startGuestSession(req, res) {
  try {
    const businessId = req.body.businessId
    const servicePointId = req.body.servicePointId
    const qrCapability = typeof req.body.qrCapability === "string"
      ? req.body.qrCapability.trim()
      : ""
    const deviceSessionId = typeof req.body.sessionId === "string"
      ? req.body.sessionId.trim()
      : ""

    if (!businessId || !servicePointId) {
      return res.status(400).json({ error: "Missing businessId or servicePointId" })
    }
    if (!deviceSessionId) {
      return res.status(400).json({ error: "Missing sessionId" })
    }
    if (!qrCapability) {
      return res.status(403).json(INVALID_QR_RESPONSE)
    }

    // Public identifiers select only a candidate scope. The signed capability
    // must match canonical tenant, ServicePoint and rotation state before any
    // current-visit authority can be created.
    const [business, servicePoint] = await Promise.all([
      Business.findOne({ businessId }),
      ServicePoint.findOne({ servicePointId, businessId })
        .select("+qrCapabilityVersion"),
    ])
    if (!isBusinessServable(business) || !servicePoint?.isActive) {
      return res.status(403).json(INVALID_QR_RESPONSE)
    }

    const qrCapabilityVersion = normalizeServicePointQrCapabilityVersion(
      servicePoint.qrCapabilityVersion
    )
    if (!servicePointQrCapabilityMatches(qrCapability, {
      businessId: servicePoint.businessId,
      servicePointId: servicePoint.servicePointId,
      version: qrCapabilityVersion,
    })) {
      return res.status(403).json(INVALID_QR_RESPONSE)
    }

    // GuestSession remains the sole downstream current-visit authority.
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
      // Bind at issuance so current reads and live streams can prove both the
      // visit credential and continuity with the device-history identity.
      boundSessionId: deviceSessionId,
      issuanceMethod: "qr_capability",
      qrCapabilityVersion,
    })

    if (resolveBusinessCapabilities(business).identity.shell === "hotel") {
      await publishServicePointsChanged({
        businessId,
        scope: "activity",
        publish: req.app?.locals?.publishEvent,
      })
    }

    // Start / resolve canonical CustomerJourney
    const journey = await startCustomerJourney({
      businessId,
      servicePointId: servicePoint.servicePointId,
      orderType: "dine-in",
      tableSessionToken: token,
      sessionId: deviceSessionId,
      journeyId: req.body.journeyId || null,
    })

    return res.json({
      token,
      expiresAt,
      businessId,
      servicePointId,
      label: servicePoint.label,
      code: servicePoint.code,
      journeyId: journey?.journeyId || null,
    })
  } catch (err) {
    if (err?.code === "SERVICE_POINT_QR_CAPABILITY_SECRET_MISSING") {
      console.error("Table session start error: QR capability signing is not configured")
      return res.status(503).json({ error: "QR session service is unavailable" })
    }
    console.error("Table session start error:", err)
    return res.status(500).json({ error: "Server error" })
  }
}

router.post("/start", tableSessionLimiter, startGuestSession)

/**
 * Public route to initialize or refresh a customer journey (e.g. for Takeaway or direct menu entry).
 */
router.post("/journey/start", tableSessionLimiter, async (req, res) => {
  try {
    const {
      businessId,
      servicePointId = null,
      orderType = "takeout",
      sessionId = null,
      journeyId = null,
    } = req.body || {}

    if (!businessId) {
      return res.status(400).json({ error: "Missing businessId" })
    }

    const business = await Business.findOne({ businessId })
    if (!isBusinessServable(business)) {
      return res.status(404).json({ error: "Business not found" })
    }

    let canonicalJourneyServicePointId = null
    if (servicePointId) {
      const servicePoint = await ServicePoint.findOne({
        businessId,
        servicePointId,
        isActive: { $ne: false },
      }).lean()
      canonicalJourneyServicePointId = servicePoint?.servicePointId || null
    }

    const journey = await startCustomerJourney({
      businessId,
      servicePointId: canonicalJourneyServicePointId,
      orderType,
      sessionId,
      journeyId,
    })

    return res.json({
      journeyId: journey?.journeyId || null,
      businessId,
      localBusinessDate: journey?.localBusinessDate || null,
    })
  } catch (err) {
    console.error("Customer journey start error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

export default router
