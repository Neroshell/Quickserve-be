import express from "express";
import { handleStripeWebhook } from "../controllers/webhookController.js";

const router = express.Router();

/**
 * POST /webhook/stripe
 *
 * IMPORTANT: This route must receive the RAW body buffer, not parsed JSON.
 * Stripe uses the raw body to verify the webhook signature.
 *
 * This route is mounted BEFORE express.json() in server.js using express.raw()
 * scoped only to this specific path.
 */
router.post(
    "/stripe",
    express.raw({ type: "application/json" }),
    handleStripeWebhook
);

export default router;
