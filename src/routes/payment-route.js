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

// POST /payments/checkout — create a Stripe Checkout Session
router.post("/checkout", checkoutLimiter, createCheckoutSession);

export default router;
