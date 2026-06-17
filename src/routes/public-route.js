import express from "express";
import rateLimit from "express-rate-limit";
import { getBusinessBySlug, createReservation, getPublicBusinessConfig } from "../controllers/publicController.js";

const router = express.Router();

// Anti-spam rate limiter for reservations
const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per `window` (here, per 15 minutes)
  message: { error: "Too many reservation requests from this IP, please try again later." },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * @openapi
 * /public/business/{slug}:
 *   get:
 *     summary: Retrieve business configuration and branding settings by slug
 *     tags:
 *       - Public
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Business details and preferences
 *       404:
 *         description: Business not found
 */
router.get("/business/:slug", getBusinessBySlug);

/**
 * @openapi
 * /public/business-config:
 *   get:
 *     summary: Public customer-facing business configuration (no auth)
 *     description: Safe public subset of business config for the customer ordering app and non-manager staff. Never returns owner, billing, Stripe, or credential fields.
 *     tags:
 *       - Public
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Public business configuration
 *       404:
 *         description: Business not found
 */
router.get("/business-config", getPublicBusinessConfig);

/**
 * @openapi
 * /public/reservations:
 *   post:
 *     summary: Request a table/point reservation
 *     tags:
 *       - Public
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - customerName
 *               - customerEmail
 *               - partySize
 *               - reservationTime
 *             properties:
 *               businessId:
 *                 type: string
 *               customerName:
 *                 type: string
 *               customerEmail:
 *                 type: string
 *               customerPhone:
 *                 type: string
 *               partySize:
 *                 type: number
 *               reservationTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Reservation requested successfully
 */
router.post("/reservations", reservationLimiter, createReservation);

export default router;
