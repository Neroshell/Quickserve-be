import express from "express";
import rateLimit from "express-rate-limit";
import { getBusinessBySlug, createReservation } from "../controllers/publicController.js";

const router = express.Router();

// Anti-spam rate limiter for reservations
const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per `window` (here, per 15 minutes)
  message: { error: "Too many reservation requests from this IP, please try again later." },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// GET /public/business/:slug
router.get("/business/:slug", getBusinessBySlug);

// POST /public/reservations
router.post("/reservations", reservationLimiter, createReservation);

export default router;
