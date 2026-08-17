import Business from "../models/Business.js";
import { resolveSubscriptionEntitlements } from "../services/subscriptionEntitlementService.js";

export function requireEntitlement(feature) {
    return async (req, res, next) => {
        try {
            const businessId = req.session?.user?.businessId;
            if (!businessId) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const business = await Business.findOne({ businessId }).lean();
            if (!business) {
                return res.status(401).json({ message: "Business not found" });
            }

            const entitlements = resolveSubscriptionEntitlements(business);

            if (!entitlements[feature]) {
                return res.status(403).json({
                    error: "ENTITLEMENT_REQUIRED",
                    feature: feature,
                    requiredPlan: "growth",
                    message: "This feature is available on the Growth plan."
                });
            }

            req.entitlements = entitlements;
            next();
        } catch (err) {
            console.error("[requireEntitlement] Error:", err);
            return res.status(500).json({ message: "Server error checking entitlements" });
        }
    };
}
