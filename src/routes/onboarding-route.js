import express from "express"
import { startSignup, resendVerificationEmail, verifyEmail, getSession, updateSession, completeOnboarding } from "../controllers/onboardingController.js"
import Plan from "../models/Plan.js"

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Onboarding
 *   description: Self-service onboarding flow
 */

router.post("/signup", startSignup)
router.post("/resend-verification", resendVerificationEmail)
router.post("/verify-email", verifyEmail)
router.get("/session/:sessionId", getSession)
router.patch("/session/:sessionId", updateSession)
router.post("/session/:sessionId/complete", completeOnboarding)

// Public endpoint — no auth required. Returns active plans for the Choose Plan step.
router.get("/plans", async (req, res) => {
    try {
        const plans = await Plan.find({ isActive: true }).sort({ monthlyPrice: 1 })
        return res.json(plans)
    } catch (err) {
        console.error("Onboarding plans error:", err)
        return res.status(500).json({ message: "Server error fetching plans" })
    }
})

export default router
