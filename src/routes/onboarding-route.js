import express from "express"
import rateLimit from "express-rate-limit"
import { startSignup, resendVerificationEmail, verifyEmail, getSession, updateSession, completeOnboarding, getAddressSuggestions } from "../controllers/onboardingController.js"
import Plan from "../models/Plan.js"

const router = express.Router()
const addressSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
})

/**
 * @swagger
 * tags:
 *   name: Onboarding
 *   description: Self-service onboarding flow
 */

router.post("/signup", startSignup)
router.post("/resend-verification", resendVerificationEmail)
router.post("/verify-email", verifyEmail)
router.get("/session/:sessionId/address-suggestions", addressSearchLimiter, getAddressSuggestions)
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
