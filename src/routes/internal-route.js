import express from "express";
import { processBillingLifecycle } from "../controllers/cronController.js";

const router = express.Router();

// This endpoint is protected by CRON_SECRET inside the controller
router.post("/cron/billing-lifecycle", processBillingLifecycle);

export default router;
