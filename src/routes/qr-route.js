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
 * GET /q/:businessId/:servicePointId
 *
 * QR scan entry point. Creates a TableSession and redirects to the frontend.
 *
 * servicePointId may be:
 *   - A stable `sp_XXXXXXXX` ID from the ServicePoint collection (new flow)
 *   - A legacy plain string like "table-1" preserved for backward compat
 */
router.get("/:businessId/:servicePointId", async (req, res) => {
  try {
    const { businessId, servicePointId } = req.params
    console.log(`QR request for ${businessId}, servicePointId: ${servicePointId}`)

    if (!businessId || !servicePointId) {
      return res.status(400).send("Missing businessId or servicePointId")
    }

    // 1. Validate business exists (check both businessId and legacy restaurantId)
    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).send("Business not found")
    }

    // 2. If this looks like a managed service point (sp_* prefix), validate it
    if (servicePointId.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId, businessId })
      if (!sp) {
        return res.status(404).send("Service point not found")
      }
      if (!sp.isActive) {
        return res
          .status(400)
          .send(`This ${sp.servicePointType === "room" ? "room" : "table"} is currently not in service.`)
      }
    }

    // 3. Create session (tableId = servicePointId for backward compat)
    const token = randomToken()
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours

    await TableSession.create({
      businessId,
      tableId: servicePointId,   // tableId field stores servicePointId — backward compat
      token,
      expiresAt,
      boundSessionId: null,
    })

    // 4. Redirect to the frontend QR intercept page
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
    const redirectUrl = `${FRONTEND_BASE_URL}/q/${encodeURIComponent(businessId)}/${encodeURIComponent(servicePointId)}`
    return res.redirect(302, redirectUrl)
  } catch (err) {
    console.error("QR start error:", err)
    return res.status(500).send("Server error")
  }
})

export default router
