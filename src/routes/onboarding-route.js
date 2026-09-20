import express from "express"
import rateLimit from "express-rate-limit"
import { startSignup, resendVerificationEmail, verifyEmail, getSession, updateSession, completeOnboarding, getAddressSuggestions } from "../controllers/onboardingController.js"
import Plan from "../models/Plan.js"
import {
    createSharedSecurityRateLimit,
    getRequestIp,
    normalizeRateLimitEmail,
} from "../middleware/sharedSecurityRateLimit.js"

const router = express.Router()
const addressSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
})
const onboardingSignupLimiter = createSharedSecurityRateLimit({
    scope: "onboarding-signup",
    windowMs: 60 * 60 * 1000,
    getDimensions: (req) => [
        { name: "ip", value: getRequestIp(req), limit: 20 },
        { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 5 },
    ],
})
const onboardingResendLimiter = createSharedSecurityRateLimit({
    scope: "onboarding-resend",
    windowMs: 60 * 60 * 1000,
    getDimensions: (req) => [
        { name: "ip", value: getRequestIp(req), limit: 30 },
        { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 5 },
    ],
})
const onboardingVerifyLimiter = createSharedSecurityRateLimit({
    scope: "onboarding-verify",
    windowMs: 30 * 60 * 1000,
    getDimensions: (req) => [
        { name: "ip", value: getRequestIp(req), limit: 50 },
        { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 10 },
    ],
})

/**
 * @swagger
 * tags:
 *   name: Onboarding
 *   description: Self-service onboarding flow
 */

router.post("/signup", onboardingSignupLimiter, startSignup)
router.post("/resend-verification", onboardingResendLimiter, resendVerificationEmail)
router.post("/verify-email", onboardingVerifyLimiter, verifyEmail)
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
