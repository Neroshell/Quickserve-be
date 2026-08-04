import express from "express";
import { processBillingLifecycle, processReservationExpiry } from "../controllers/cronController.js";
import {
    enqueueQueueDiagnostic,
    getQueueHealth,
} from "../controllers/queueDiagnosticController.js";
import { requireInternalSecret } from "../middleware/internalSecretAuth.js";
import { recoverQueuedEmails } from "../controllers/emailQueueRecoveryController.js";
import { recoverPostPaymentCrm } from "../controllers/postPaymentRecoveryController.js";

const router = express.Router();

// Retained as authenticated manual recovery paths during BullMQ rollout.
// These handlers execute repairs; they never register recurring schedulers.
router.post(
    "/cron/billing-lifecycle",
    requireInternalSecret,
    processBillingLifecycle,
);
router.post(
    "/cron/reservation-expiry",
    requireInternalSecret,
    processReservationExpiry,
);

// Phase 0 diagnostics only. No production business task is enqueued here.
router.post("/queue/diagnostic", requireInternalSecret, enqueueQueueDiagnostic);
router.get("/queue/health", requireInternalSecret, getQueueHealth);
router.post("/queue/email/recover", requireInternalSecret, recoverQueuedEmails);
router.post(
    "/queue/post-payment/recover",
    requireInternalSecret,
    recoverPostPaymentCrm,
);

export default router;
