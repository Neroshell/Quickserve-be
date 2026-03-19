import express from "express"
import crypto from "crypto"
import TableSession from "../models/TableSession.js"
import Restaurant from "../models/Restaurant.js"

const router = express.Router()

function randomToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString("base64url")
}

// POST /table-session/start
router.post("/start", async (req, res) => {
  try {
    const { restaurantId, tableId } = req.body
    
    if (!restaurantId || !tableId) {
      return res.status(400).json({ error: "Missing restaurantId or tableId" })
    }

    // Validate that the restaurant actually exists
    const restaurant = await Restaurant.findOne({ restaurantId })
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" })
    }

    const token = randomToken()
    // Session length ideally comes from restaurant settings (e.g. `restaurant.settings.service.sessionExpiryMinutes`).
    // Using a default fallback of 120 minutes for now to match old behavior.
    const fallbackMinutes = 120
    const expiryMinutes = restaurant?.settings?.service?.sessionExpiryMinutes || fallbackMinutes
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000)

    await TableSession.create({
      restaurantId,
      tableId,
      token,
      expiresAt,
      boundSessionId: null,
    })

    return res.json({
      token,
      expiresAt,
      restaurantId,
      tableId
    })
  } catch (err) {
    console.error("Table session start error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

export default router
