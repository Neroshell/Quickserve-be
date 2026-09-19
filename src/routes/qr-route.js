import express from "express"
import rateLimit from "express-rate-limit"
import Business from "../models/Business.js"
import ServicePoint from "../models/ServicePoint.js"
import { isBusinessServable } from "../utils/restaurantOrderValidation.js"

const router = express.Router()

// Preserve defense-in-depth limiting for the legacy backend QR redirect.
const qrRedirectLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
})

/**
 * GET /q/:businessId/:servicePointId
 *
 * Legacy API-origin QR entry point. It never creates GuestSession state. The
 * frontend bootstrap must submit the signed QR capability to /table-session/start.
 *
 * @openapi
 * /q/{businessId}/{servicePointId}:
 *   get:
 *     summary: Legacy QR redirect to the customer frontend bootstrap
 *     tags:
 *       - QR Scanning
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: servicePointId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirects to frontend QR bootstrap; no GuestSession is issued
 *       404:
 *         description: Business or ServicePoint not found
 */
router.get("/:businessId/:servicePointId", qrRedirectLimiter, async (req, res) => {
  try {
    const { businessId, servicePointId } = req.params
    if (!businessId || !servicePointId) {
      return res.status(400).send("Missing businessId or servicePointId")
    }

    const [business, servicePoint] = await Promise.all([
      Business.findOne({ businessId }),
      ServicePoint.findOne({ businessId, servicePointId }),
    ])
    if (!isBusinessServable(business) || !servicePoint) {
      return res.status(404).send("QR destination not found")
    }
    if (!servicePoint.isActive) {
      return res.status(400).send("This service point is currently not in service.")
    }

    // Secure generated QR URLs keep the capability in a fragment. Fragments
    // are not sent to this server, logged, or reflected in the redirect URL.
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
    const redirectUrl = `${frontendBaseUrl}/q/${encodeURIComponent(businessId)}/${encodeURIComponent(servicePointId)}`
    return res.redirect(302, redirectUrl)
  } catch (error) {
    console.error("QR redirect error:", error)
    return res.status(500).send("Server error")
  }
})

export default router
