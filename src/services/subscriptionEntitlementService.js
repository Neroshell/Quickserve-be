export function resolveSubscriptionEntitlements(business) {
    // Default to basic entitlements
    const entitlements = {
        crm: false,
        advancedAnalytics: false,
        advancedBranding: false,
    };

    if (!business) {
        return entitlements;
    }

    // Safely unwrap Mongoose document if necessary
    const businessObject = typeof business.toObject === "function" ? business.toObject() : business;
    const { currentPlan } = businessObject;

    // We grant Growth entitlements solely based on the currentPlan.
    // Offline payment failure or past_due billingStatus does not remove CRM or Analytics.
    if (currentPlan === 'growth') {
        entitlements.crm = true;
        entitlements.advancedAnalytics = true;
        entitlements.advancedBranding = true;
    }

    return entitlements;
}
