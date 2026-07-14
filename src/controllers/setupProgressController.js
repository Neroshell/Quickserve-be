import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import ServicePoint from "../models/ServicePoint.js"
import Staff from "../models/Staff.js"

const BRANDING_PLANS = new Set(["growth", "pro"])

const DEFAULT_BRANDING = {
    primaryColor: "#EA601A",
    secondaryColor: "#2B304C",
    accentColor: "#FB923C",
    backgroundColor: "#F8F9FA"
}

const BUSINESS_SELECT = [
    "businessId",
    "currentPlan",
    "plan",
    "stripeOnboardingComplete",
    "stripeChargesEnabled",
    "stripePayoutsEnabled",
    "defaultPaymentMethodId",
    "logoUrl",
    "branding",
    "setupProgress"
].join(" ")

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function normalizePlan(business) {
    return String(business.currentPlan || business.plan || "basic").toLowerCase()
}

function hasChangedBrandColor(branding = {}) {
    return Object.entries(DEFAULT_BRANDING).some(([field, defaultValue]) => {
        return hasText(branding[field]) && branding[field] !== defaultValue
    })
}

function hasConfiguredBranding(business) {
    const branding = business.branding || {}

    return Boolean(
        hasText(business.logoUrl) ||
        hasText(branding.logoUrl) ||
        hasText(branding.coverImageUrl) ||
        hasChangedBrandColor(branding)
    )
}

function buildSetupProgressResponse(business, counts) {
    const plan = normalizePlan(business)
    const brandingEligible = BRANDING_PLANS.has(plan)

    const tasks = {
        stripeConnected: business.stripeOnboardingComplete === true ||
            (business.stripeChargesEnabled === true && business.stripePayoutsEnabled === true),
        billingCardAdded: hasText(business.defaultPaymentMethodId),
        menuItemAdded: counts.menuItemCount > 0,
        servicePointCreated: counts.servicePointCount > 0,
        brandingConfigured: brandingEligible && hasConfiguredBranding(business),
        staffInvited: counts.staffCount > 0,
        firstOrderPlaced: counts.orderCount > 0
    }

    const eligibleTaskKeys = [
        "stripeConnected",
        "billingCardAdded",
        "menuItemAdded",
        "servicePointCreated",
        ...(brandingEligible ? ["brandingConfigured"] : []),
        "staffInvited",
        "firstOrderPlaced"
    ]

    const completedCount = eligibleTaskKeys.filter((key) => tasks[key]).length
    const totalEligibleTasks = eligibleTaskKeys.length

    return {
        title: "Business Setup",
        subtitle: "Get Ready to Accept Orders",
        estimatedSetupTime: "5-10 minutes",
        plan,
        tasks,
        eligibility: {
            branding: brandingEligible
        },
        lockedTasks: {
            branding: brandingEligible ? null : {
                reason: "Growth or Pro required",
                actionLabel: "Upgrade Plan"
            }
        },
        completedCount,
        totalEligibleTasks,
        progressPercent: totalEligibleTasks === 0
            ? 0
            : Math.round((completedCount / totalEligibleTasks) * 100),
        complete: completedCount === totalEligibleTasks,
        dismissed: business.setupProgress?.setupGuideDismissed === true,
        counts
    }
}

async function getSetupProgressData(businessId) {
    const business = await Business.findOne({ businessId }).select(BUSINESS_SELECT).lean()
    if (!business) {
        return null
    }

    const [
        menuItemCount,
        servicePointCount,
        staffCount,
        orderCount
    ] = await Promise.all([
        MenuItem.countDocuments({ businessId }),
        ServicePoint.countDocuments({ businessId }),
        Staff.countDocuments({ businessId, accountStatus: { $ne: "disabled" } }),
        Order.countDocuments({ businessId })
    ])

    const counts = {
        menuItemCount,
        servicePointCount,
        staffCount,
        orderCount
    }

    return {
        business,
        progress: buildSetupProgressResponse(business, counts)
    }
}

export async function getSetupProgress(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const data = await getSetupProgressData(businessId)
        if (!data) {
            return res.status(404).json({ error: "Business not found" })
        }

        return res.json(data.progress)
    } catch (err) {
        console.error("[getSetupProgress]", err)
        return res.status(500).json({ error: "Server error fetching setup progress" })
    }
}

export async function dismissSetupGuide(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const data = await getSetupProgressData(businessId)
        if (!data) {
            return res.status(404).json({ error: "Business not found" })
        }

        if (!data.progress.complete) {
            return res.status(400).json({
                error: "Setup guide can only be dismissed after all eligible tasks are complete",
                setupProgress: data.progress
            })
        }

        await Business.updateOne(
            { businessId },
            {
                $set: {
                    "setupProgress.setupGuideDismissed": true,
                    "setupProgress.setupGuideDismissedAt": new Date(),
                    onboardingCompleted: true,
                    onboardingCompletedAt: new Date()
                }
            }
        )

        const updatedData = await getSetupProgressData(businessId)
        return res.json({
            message: "Setup guide dismissed",
            setupProgress: updatedData.progress
        })
    } catch (err) {
        console.error("[dismissSetupGuide]", err)
        return res.status(500).json({ error: "Server error dismissing setup guide" })
    }
}
