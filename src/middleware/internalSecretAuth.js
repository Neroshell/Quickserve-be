export function requireInternalSecret(req, res, next) {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
        console.error("[InternalAuth] CRON_SECRET is not configured");
        return res.status(500).json({ error: "Server misconfiguration" });
    }

    if (req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    return next();
}
