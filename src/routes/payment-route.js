import express from "express";
import { createCheckoutSession } from "../controllers/paymentController.js";

const router = express.Router();

// POST /payments/checkout — create a Stripe Checkout Session
router.post("/checkout", createCheckoutSession);

export default router;
