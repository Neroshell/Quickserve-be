import { recoverEmailDeliveries } from "../services/email/emailRecoveryService.js";
import { isBullMqEmailsEnabled } from "../services/email/emailDispatchService.js";

export async function recoverQueuedEmails(req, res) {
  if (!isBullMqEmailsEnabled()) {
    return res.status(503).json({ error: "Queued email delivery is disabled" });
  }

  const businessId = String(req.body?.businessId || "").trim();
  if (!businessId) {
    return res.status(400).json({ error: "businessId is required" });
  }
  const requestedLimit = Number(req.body?.limit);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 100;

  try {
    const summary = await recoverEmailDeliveries({ businessId, limit });
    return res.status(summary.failed > 0 ? 207 : 202).json({
      recoveryStarted: true,
      businessId,
      summary,
    });
  } catch (error) {
    console.error("[EmailRecovery] Recovery failed", {
      businessId,
      reason: error?.code || error?.name || "recovery_failed",
    });
    return res.status(503).json({ error: "Email recovery unavailable" });
  }
}
