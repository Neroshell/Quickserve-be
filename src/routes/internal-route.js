import express from "express";
import { processBillingLifecycle, processReservationExpiry } from "../controllers/cronController.js";

const router = express.Router();

// This endpoint is protected by CRON_SECRET inside the controller
router.post("/cron/billing-lifecycle", processBillingLifecycle);
router.post("/cron/reservation-expiry", processReservationExpiry);

export default router;
