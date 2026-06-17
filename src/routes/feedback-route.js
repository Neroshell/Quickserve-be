import express from "express"
import { submitFeedback } from "../controllers/feedbackController.js"

const router = express.Router()

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
router.post("/", submitFeedback)

export default router
