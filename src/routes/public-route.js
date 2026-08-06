import express from "express";
import rateLimit from "express-rate-limit";
import { getBusinessBySlug, createReservation, getPublicBusinessConfig, getReservationByToken, getReservationById } from "../controllers/publicController.js";
import { getAvailableStayServicePoints } from "../controllers/reservationController.js";
import { getPlans } from "../controllers/planController.js";
import {
  checkInReservationArrival,
  validateReservationArrival,
} from "../controllers/reservationArrivalController.js";

const router = express.Router();

// Anti-spam rate limiter for reservations
const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per `window` (here, per 15 minutes)
  message: { error: "Too many reservation requests from this IP, please try again later." },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const arrivalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    outcome: "rate_limited",
    message: "Too many check-in attempts. Please try again shortly.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @openapi
 * /public/business/{countryCode}/{slug}:
 *   get:
 *     summary: Retrieve business configuration and branding settings by slug
 *     tags:
 *       - Public
 *     parameters:
 *       - in: path
 *         name: countryCode
 *         required: true
 *         schema:
 *           type: string
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
 *       302:
 *         description: Redirects for legacy requests
 */
router.get("/business/:countryCode/:slug", getBusinessBySlug);

// Legacy fallback route for backward compatibility
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

router.post(
  "/reservations/arrival/validate",
  arrivalLimiter,
  validateReservationArrival,
);

router.post(
  "/reservations/arrival/check-in",
  arrivalLimiter,
  checkInReservationArrival,
);

/**
 * @openapi
 * /public/reservations/available-rooms:
 *   get:
 *     summary: Fetch ServicePoints available for a stay
 *     tags:
 *       - Public
 */
router.get("/reservations/available-rooms", getAvailableStayServicePoints);

/**
 * @openapi
 * /public/reservations/by-token/{secureToken}:
 *   get:
 *     summary: Fetch a reservation by secure token for payment
 *     tags:
 *       - Public
 */
router.get("/reservations/by-token/:secureToken", getReservationByToken);

/**
 * @openapi
 * /public/reservations/by-id/{reservationId}:
 *   get:
 *     summary: Fetch a reservation by ID for the post-payment confirmation page
 *     tags:
 *       - Public
 */
router.get("/reservations/by-id/:reservationId", getReservationById);

/**
 * @openapi
 * /public/plans:
 *   get:
 *     summary: Get all available plans
 *     tags:
 *       - Public
 *     responses:
 *       200:
 *         description: List of plans
 */
router.get("/plans", getPlans);

export default router;
