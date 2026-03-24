import Waiter from "../models/Waiter.js"
import crypto from "crypto"
import { sendWaiterInvitationEmail } from "../utils/emailService.js"

/**
 * Get all waiters for a restaurant
 * GET /owner/waiters?restaurantId=...&status=...
 */
export async function getWaiters(req, res) {
    try {
        const { restaurantId, status } = req.query
        
        if (!restaurantId) {
            return res.status(400).json({ error: "restaurantId is required" })
        }

        const filter = { restaurantId }
        // Presence Filter
        if (status && status !== "all") {
            filter.presenceStatus = status
        }

        const waiters = await Waiter.find(filter).sort({ createdAt: -1 })
        
        return res.json(waiters)
    } catch (err) {
        console.error("[getWaiters]", err)
        return res.status(500).json({ error: "Failed to fetch waiters" })
    }
}

/**
 * Create a new waiter
 * POST /owner/waiters?restaurantId=...
 */
export async function createWaiter(req, res) {
    try {
        const { restaurantId } = req.query
        const { waiterId, name, email, status } = req.body

        if (!restaurantId) {
            return res.status(400).json({ error: "restaurantId is required" })
        }

        if (!waiterId || !name || !email) {
            return res.status(400).json({ error: "waiterId, name, and email are required" })
        }

        // Check for existing waiterId in this restaurant
        const existingId = await Waiter.findOne({ restaurantId, waiterId })
        if (existingId) {
            return res.status(409).json({ message: "A waitstaff with this ID already exists in your business." })
        }

        // Check for existing email in this restaurant
        const existingEmail = await Waiter.findOne({ restaurantId, email })
        if (existingEmail) {
            return res.status(409).json({ message: "A waitstaff with this email already exists in your business." })
        }

        // Generate secure invite token
        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

        const waiter = await Waiter.create({
            restaurantId,
            waiterId,
            name,
            email,
            accountStatus: "pending",
            presenceStatus: "offline",
            status: "offline", // sync
            inviteToken,
            inviteTokenExpires
        })

        // Send email
        const frontendUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
        const inviteLink = `${frontendUrl}/staff/setup-account?token=${inviteToken}`
        
        sendWaiterInvitationEmail(waiter, inviteLink).catch(err => {
            console.error("[createWaiter] Email failed:", err)
        })

        return res.status(201).json(waiter)
    } catch (err) {
        console.error("[createWaiter]", err)
        return res.status(500).json({ error: "Failed to create waiter" })
    }
}

/**
 * Remove a waiter
 * DELETE /owner/waiters/:waiterId?restaurantId=...
 */
export async function deleteWaiter(req, res) {
    try {
        const { restaurantId } = req.query
        const { id } = req.params

        if (!restaurantId) {
            return res.status(400).json({ error: "restaurantId is required" })
        }

        const result = await Waiter.findOneAndDelete({ restaurantId, waiterId: id })
        
        if (!result) {
            return res.status(404).json({ error: "Waitstaff not found" })
        }

        return res.json({ message: "Waitstaff removed successfully" })
    } catch (err) {
        console.error("[deleteWaiter]", err)
        return res.status(500).json({ error: "Failed to remove waiter" })
    }
}
