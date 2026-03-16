import express from "express"
import crypto from "crypto"
import TableSession from "../models/TableSession.js"
import Restaurant from "../models/Restaurant.js"

const router = express.Router()

function randomToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString("base64url")
}

// GET /q/:restaurantId/:tableId -> create token, redirect to frontend with ?st=
router.get("/:restaurantId/:tableId", async (req, res) => {
  try {
    const { restaurantId, tableId } = req.params
    console.log(`QR request for ${restaurantId}, tableId: ${tableId}`);

    if (!restaurantId || !tableId) {
      return res.status(400).send("Missing restaurantId or tableId")
    }

    // Validate that the restaurant actually exists
    const restaurant = await Restaurant.findOne({ restaurantId })
    if (!restaurant) {
      return res.status(404).send("Restaurant not found")
    }

    const token = randomToken()
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours

    await TableSession.create({
      restaurantId,
      tableId,
      token,
      expiresAt,
      boundSessionId: null,
    })

    // frontend base url (set in env for prod)
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000"

    const redirectUrl = `${FRONTEND_BASE_URL}/table/${encodeURIComponent(tableId)}?restaurantId=${encodeURIComponent(restaurantId)}&st=${encodeURIComponent(token)}`
    return res.redirect(302, redirectUrl)
  } catch (err) {
    console.error("QR start error:", err)
    return res.status(500).send("Server error")
  }
})

export default router
