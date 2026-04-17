import express from "express"
import crypto from "crypto"
import TableSession from "../models/TableSession.js"
import Restaurant from "../models/Restaurant.js"

const router = express.Router()

function randomToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString("base64url")
}

// GET /q/:businessId/:tableId -> create token, redirect to frontend with ?st=
router.get("/:businessId/:tableId", async (req, res) => {
  try {
    const { businessId, tableId } = req.params
    console.log(`QR request for ${businessId}, tableId: ${tableId}`);

    if (!businessId || !tableId) {
      return res.status(400).send("Missing businessId or tableId")
    }

    // Validate that the business actually exists (check both businessId and legacy restaurantId)
    const restaurant = await Restaurant.findOne({
      $or: [{ businessId }, { restaurantId: businessId }]
    })
    if (!restaurant) {
      return res.status(404).send("Business not found")
    }

    const token = randomToken()
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours

    await TableSession.create({
      businessId,
      tableId,
      token,
      expiresAt,
      boundSessionId: null,
    })

    // frontend base url (set in env for prod)
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000"

    const redirectUrl = `${FRONTEND_BASE_URL}/table/${encodeURIComponent(tableId)}?businessId=${encodeURIComponent(businessId)}&st=${encodeURIComponent(token)}`
    return res.redirect(302, redirectUrl)
  } catch (err) {
    console.error("QR start error:", err)
    return res.status(500).send("Server error")
  }
})

export default router
