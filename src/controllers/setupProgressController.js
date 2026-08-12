import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import ServicePoint from "../models/ServicePoint.js"
import Staff from "../models/Staff.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"

import {
    CACHE_TTL_SECONDS,
    cacheKeys,
    responseCache,
} from "../services/responseCacheService.js"
import { invalidateSetupProgress } from "../services/cacheInvalidationService.js"

const BUSINESS_SELECT = [
    "businessId",
    "businessType",
    "currentPlan",
    "plan",
    "stripeOnboardingComplete",
    "stripeChargesEnabled",
    "stripePayoutsEnabled",
    "defaultPaymentMethodId",
    "operatingHours",
    "modules",
    "setupProgress"
].join(" ")

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function buildTasks(business, counts, capabilities) {
    const isHotel = capabilities.identity.shell === "hotel";
    const hasFoodService = capabilities.visibleModules.includes("foodService");

    const stripeConnected = business.stripeOnboardingComplete === true ||
        (business.stripeChargesEnabled === true && business.stripePayoutsEnabled === true);
    
    const offlinePaymentsConfigured = hasText(business.defaultPaymentMethodId);

    const tasks = [];
    let stage = 1;

    // 1. Where customers order
    const servicePointLabel = isHotel ? "room" : "table";
    tasks.push({
        id: "service_point",
        stage: stage++,
        title: `Add your first ${servicePointLabel}`,
        description: `Customers need a ${servicePointLabel} before they can start an order.`,
        href: "/owner/service-points?create=1",
        classification: "required",
        completed: counts.servicePointCount > 0
    });

    // 2. Readiness / Menu
    if (hasFoodService) {
        tasks.push({
            id: "menu_item",
            stage: stage++,
            title: "Create your first menu item",
            description: "Add items for your customers to order.",
            href: "/owner/menu?create=1",
            classification: "required",
            completed: counts.menuItemCount > 0
        });
    } else if (isHotel) {
        tasks.push({
            id: "room_readiness",
            stage: stage++,
            title: "Set your room pricing",
            description: "Rooms must have pricing and capacity to be booked.",
            href: "/owner/service-points",
            classification: "required",
            completed: counts.readyRoomCount > 0
        });
    }

    // 3. Team (restaurant only)
    if (!isHotel) {
        tasks.push({
            id: "team",
            stage: stage++,
            title: "Create your first staff member",
            description: "Add your team members to help manage orders.",
            href: "/owner/staff?create=1",
            classification: "recommended",
            completed: counts.staffCount > 0
        });
    }

    // 4. Offline Payments (restaurant only)
    if (!isHotel) {
        tasks.push({
            id: "payments_offline",
            stage: stage++,
            title: "Set up offline payments",
            description: "Add a card to receive offline commission invoices.",
            href: "/owner/billing?action=add-card",
            classification: "recommended",
            completed: offlinePaymentsConfigured
        });
    }

    // 5. Online Payments
    tasks.push({
        id: "payments_online",
        stage: stage++,
        title: "Set up online payments",
        description: "Connect your bank to receive online payments.",
        href: "/owner/billing?tab=payouts",
        classification: isHotel ? "required" : "recommended",
        completed: stripeConnected
    });

    // Hotel only: Verify booking
    if (isHotel) {
        tasks.push({
            id: "verify",
            stage: stage++,
            title: "Test your first booking",
            description: "Make sure everything works by placing a test booking.",
            href: "/",
            classification: "verification",
            completed: counts.orderCount > 0
        });
    }

    return tasks;
}

function buildSetupProgressResponse(business, counts, capabilities) {
    const tasks = buildTasks(business, counts, capabilities);

    const requiredTasks = tasks.filter(t => t.classification === "required");
    const completedRequiredCount = requiredTasks.filter(t => t.completed).length;
    
    // The tracker visually represents all core steps in the sequence
    const totalCoreCount = tasks.length;
    const completedCoreCount = tasks.filter(t => t.completed).length;
    
    // Completion of the setup journey requires ALL tasks in the sequence to be done
    const complete = completedCoreCount === totalCoreCount;
    
    let nextAction = null;
    // Next action points to the first uncompleted task in the entire journey
    for (const task of tasks) {
        if (!task.completed) {
            nextAction = task;
            break;
        }
    }

    return {
        title: "Setup Progress",
        subtitle: "Get Ready to Accept Orders",
        tasks,
        nextAction,
        completedRequiredCount,
        totalRequiredCount: requiredTasks.length,
        completedCoreCount,
        totalCoreCount,
        progressPercent: totalCoreCount === 0 ? 100 : Math.round((completedCoreCount / totalCoreCount) * 100),
        complete,
        dismissed: business.setupProgress?.setupGuideDismissed === true,
        counts
    };
}

async function getSetupProgressData(businessId) {
    const business = await Business.findOne({ businessId }).select(BUSINESS_SELECT).lean();
    if (!business) {
        return null;
    }

    const capabilities = resolveBusinessCapabilities(business);
    
    const [
        menuItemCount,
        servicePointCount,
        readyRoomCount,
        staffCount,
        orderCount
    ] = await Promise.all([
        MenuItem.countDocuments({ businessId }),
        ServicePoint.countDocuments({ businessId }),
        ServicePoint.countDocuments({ businessId, servicePointType: "room", pricePerNight: { $gt: 0 }, maxGuests: { $gt: 0 } }),
        Staff.countDocuments({ businessId, accountStatus: { $ne: "disabled" } }),
        Order.countDocuments({ businessId })
    ]);

    const counts = {
        menuItemCount,
        servicePointCount,
        readyRoomCount,
        staffCount,
        orderCount
    };

    return {
        business,
        progress: buildSetupProgressResponse(business, counts, capabilities)
    };
}

export async function getSetupProgress(req, res) {
    try {
        const businessId = req.session?.user?.businessId;
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const cacheKey = cacheKeys.setupProgress(businessId)
        const cached = await responseCache.get(cacheKey)
        if (
            cached.hit &&
            cached.value &&
            typeof cached.value === "object" &&
            !Array.isArray(cached.value)
        ) {
            return res.json(cached.value)
        }

        const data = await getSetupProgressData(businessId);
        if (!data) {
            return res.status(404).json({ error: "Business not found" });
        }

        await responseCache.set(
            cacheKey,
            data.progress,
            CACHE_TTL_SECONDS.TENANT_STABLE,
        )

        return res.json(data.progress);
    } catch (err) {
        console.error("[getSetupProgress]", err);
        return res.status(500).json({ error: "Server error fetching setup progress" });
    }
}

export async function dismissSetupGuide(req, res) {
    try {
        const businessId = req.session?.user?.businessId;
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const data = await getSetupProgressData(businessId);
        if (!data) {
            return res.status(404).json({ error: "Business not found" });
        }

        if (!data.progress.complete) {
            return res.status(400).json({
                error: "Setup guide can only be dismissed after all required tasks are complete",
                setupProgress: data.progress
            });
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
        );

        await invalidateSetupProgress(businessId)

        const updatedData = await getSetupProgressData(businessId);
        return res.json({
            message: "Setup guide dismissed",
            setupProgress: updatedData.progress
        });
    } catch (err) {
        console.error("[dismissSetupGuide]", err);
        return res.status(500).json({ error: "Server error dismissing setup guide" });
    }
}
