import express from "express"
import crypto from "crypto"
import TableSession from "../models/TableSession.js"

const router = express.Router()

function randomToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString("base64url")
}

// GET /q/:tableId -> create token, redirect to frontend with ?st=
router.get("/:tableId", async (req, res) => {
  try {

    console.log("QR request for tableId:", req.params.tableId);
    const { tableId } = req.params
    if (!tableId) return res.status(400).send("Missing tableId")


    const token = randomToken()
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours

    await TableSession.create({
      tableId,
      token,
      expiresAt,
      boundSessionId: null,
    })

    // frontend base url (set in env for prod)
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000"

    const redirectUrl = `${FRONTEND_BASE_URL}/table/${encodeURIComponent(tableId)}?st=${encodeURIComponent(token)}`
    return res.redirect(302, redirectUrl)
  } catch (err) {
    console.error("QR start error:", err)
    return res.status(500).send("Server error")
  }
})

export default router
