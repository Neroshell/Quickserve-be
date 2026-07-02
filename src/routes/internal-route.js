import express from "express";
import { sendBillingReminders } from "../controllers/cronController.js";

const router = express.Router();

// This endpoint is protected by CRON_SECRET inside the controller
router.post("/cron/billing-reminders", sendBillingReminders);

export default router;
