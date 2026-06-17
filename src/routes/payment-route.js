import express from "express";
import rateLimit from "express-rate-limit";
import { createCheckoutSession } from "../controllers/paymentController.js";

const router = express.Router();

// Strict rate limiter for checkout — prevents Stripe session abuse
const checkoutLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5-minute window
  max: 10,                   // Max 10 checkout attempts per IP per window
  message: { message: "Too many checkout attempts. Please try again shortly." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @openapi
 * /payments/checkout:
 *   post:
 *     summary: Create a Stripe Checkout Session for order payment
 *     tags:
 *       - Payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *             properties:
 *               orderId:
 *                 type: string
 *               successUrl:
 *                 type: string
 *               cancelUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Stripe checkout session URL generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 */
router.post("/checkout", checkoutLimiter, createCheckoutSession);

export default router;
