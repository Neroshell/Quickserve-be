import {
    runBillingLifecycleRecovery,
} from "../services/billingLifecycleService.js";
import {
    runReservationExpiryRepairScan,
} from "../services/reservationExpiryService.js";

function authorizeCronRequest(req, res) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.error("[Cron] CRON_SECRET is not configured");
        res.status(500).json({ error: "Server misconfiguration" });
        return false;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }
    return true;
}

export async function processBillingLifecycle(req, res) {
    if (!authorizeCronRequest(req, res)) return;
    try {
        const runRecovery =
            req.app?.locals?.runBillingLifecycleRecovery ||
            runBillingLifecycleRecovery;
        const result = await runRecovery({ now: new Date() });
        const completed = result.results.filter(
            (entry) => entry.status === "completed",
        );
        return res.json({
            mode: "manual_recovery",
            summary: {
                checked: result.summary.candidates,
                sent: result.summary.completed,
                skipped: 0,
                failed: result.summary.failed,
                restricted: completed.filter(
                    (entry) => entry.jobName === "billing-restrict-service",
                ).length,
                restored: completed.filter(
                    (entry) => entry.jobName === "billing-restore-service",
                ).length,
            },
            results: result.results,
        });
    } catch (error) {
        console.error("[Cron] Unhandled error in billing lifecycle:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}

export async function processReservationExpiry(req, res) {
    if (!authorizeCronRequest(req, res)) return;
    try {
        const runRepairScan =
            req.app?.locals?.runReservationExpiryRepairScan ||
            runReservationExpiryRepairScan;
        const result = await runRepairScan({ now: new Date() });
        return res.json({
            message: "Reservation expiry processed",
            mode: "manual_recovery",
            matchedCount: result.matchedCount,
            expiredCount: result.expiredCount,
        });
    } catch (error) {
        console.error("[Cron] Unhandled error in reservation expiry:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
