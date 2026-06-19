import express from "express"
import rateLimit from "express-rate-limit"
import { submitFeedback } from "../controllers/feedbackController.js"

const router = express.Router()

// Anti-spam: feedback is public (no login), so cap submissions per IP.
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many feedback submissions. Please try again later." },
})

/**
 * @openapi
 * /feedback/:
 *   post:
 *     summary: Submit customer feedback for an order
 *     tags:
 *       - Feedback
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - orderId
 *               - rating
 *             properties:
 *               businessId:
 *                 type: string
 *               orderId:
 *                 type: string
 *               rating:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 5
 *               comments:
 *                 type: string
 *     responses:
 *       201:
 *         description: Feedback submitted successfully
 */
router.post("/", feedbackLimiter, submitFeedback)

export default router
