import Business from "../models/Business.js";

export async function requireOfflineServiceActive(req, res, next) {
    try {
        if (!req.session || !req.session.user || !req.session.user.businessId) {
            return res.status(401).json({ message: "Unauthorized." });
        }

        const business = await Business.findOne({
            businessId: req.session.user.businessId,
        }).lean();

        if (business?.offlineServiceRestricted) {
            return res.status(403).json({
                error: "Offline services are temporarily restricted due to an overdue QuickServe payment. Please update your billing method to restore access.",
            });
        }

        next();
    } catch (err) {
        console.error("[requireOfflineServiceActive] Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
