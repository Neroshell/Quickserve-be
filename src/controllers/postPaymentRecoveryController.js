import { scanCrmOrderRepairs } from "../services/guestProfileService.js";

export async function recoverPostPaymentCrm(req, res) {
    try {
        const scan = req.app?.locals?.scanCrmOrderRepairs || scanCrmOrderRepairs;
        const summary = await scan({ now: new Date() });
        return res.json({ mode: "manual_recovery", summary });
    } catch (error) {
        console.error("[CRM] Manual post-payment recovery failed", {
            reason: error?.code || error?.name || "repair_failed",
        });
        return res.status(500).json({ error: "Post-payment CRM recovery failed" });
    }
}
