import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import ServicePoint from "../models/ServicePoint.js"
import Staff from "../models/Staff.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"
import { getConfiguredPublicReservationModes } from "../services/publicReservationBookabilityService.js"
import {
    getReservationEligibility,
    withReservationEligibilityFence,
} from "../services/reservationEligibilityService.js"

import {
    CACHE_TTL_SECONDS,
    cacheKeys,
    responseCache,
} from "../services/responseCacheService.js"
import { invalidateSetupProgress } from "../services/cacheInvalidationService.js"

const BUSINESS_SELECT = [
    "businessId",
    "businessType",
    "countryCode",
    "slug",
    "status",
    "onboardingCompleted",
    "currentPlan",
    "plan",
    "stripeOnboardingComplete",
    "stripeChargesEnabled",
    "stripePayoutsEnabled",
    "defaultPaymentMethodId",
    "operatingHours",
    "modules",
    "settings",
    "setupProgress"
].join(" ")

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function getStayPreviewHref(business) {
    const countryCode = typeof business?.countryCode === "string"
        ? business.countryCode.trim().toLowerCase()
        : ""
    const slug = typeof business?.slug === "string"
        ? business.slug.trim().toLowerCase()
        : ""

    if (!/^[a-z]{2}$/.test(countryCode) || !/^[a-z0-9-]+$/.test(slug)) {
        return null
    }

    return `/reserve/${encodeURIComponent(countryCode)}/${encodeURIComponent(slug)}?mode=stay`
}

function buildAccommodationBookingReadiness(business, capabilities) {
    if (!capabilities.visibleModules.includes("lodging")) return null

    const configuredModes = getConfiguredPublicReservationModes(business)
    const onlineReservationsEnabled = business?.settings?.reservationsEnabled !== false
    const publicStayReservationsEnabled = configuredModes.includes("stay")
    const eligibility = getReservationEligibility(business)
    const blockers = []

    if (!onlineReservationsEnabled) blockers.push("Online reservations are disabled.")
    if (!publicStayReservationsEnabled) blockers.push("Public stay booking is disabled.")
    if (!eligibility.eligible) blockers.push(eligibility.message)

    return {
        onlineReservationsEnabled,
        publicStayReservationsEnabled,
        publicBookingEligible: onlineReservationsEnabled && publicStayReservationsEnabled && eligibility.eligible,
        blockers,
    }
}

export function buildSetupTasks(business, counts, capabilities) {
    const isAccommodation = capabilities.visibleModules.includes("lodging");
    const hasFoodService = capabilities.visibleModules.includes("foodService");

    const stripeConnected = business.stripeOnboardingComplete === true ||
        (business.stripeChargesEnabled === true && business.stripePayoutsEnabled === true);
    
    const offlinePaymentsConfigured = hasText(business.defaultPaymentMethodId);

    const tasks = [];
    let stage = 1;

    const servicePointLabel = isAccommodation ? "room" : "table";
    tasks.push({
        id: "service_point",
        stage: stage++,
        title: `Add your first ${servicePointLabel}`,
        description: isAccommodation
            ? "Add a room or accommodation unit so guests have somewhere to stay."
            : "Customers need a table before they can start an order.",
        href: isAccommodation ? "/owner/service-points?view=rooms&create=1" : "/owner/service-points?create=1",
        classification: "required",
        completed: isAccommodation ? counts.roomCount > 0 : counts.servicePointCount > 0
    });

    if (isAccommodation) {
        tasks.push({
            id: "room_readiness",
            stage: stage++,
            title: "Configure room pricing & capacity",
            description: "Set your room rates and guest capacity to prepare your accommodation for bookings.",
            href: "/owner/service-points?view=rooms",
            classification: "required",
            completed: counts.readyRoomCount > 0
        });

        tasks.push({
            id: "reservation_settings",
            stage: stage++,
            title: "Configure guest reservations",
            description: "Review your booking preferences and choose how guests can reserve your accommodation.",
            href: "/owner/settings",
            classification: "recommended",
            completed: counts.publicStayReservationsEnabled === true
        });
    } else if (hasFoodService) {
        tasks.push({
            id: "menu_item",
            stage: stage++,
            title: "Create your first menu item",
            description: "Add items for your customers to order.",
            href: "/owner/menu?create=1",
            classification: "required",
            completed: counts.menuItemCount > 0
        });
    }

    if (isAccommodation && hasFoodService) {
        tasks.push({
            id: "food_service_menu",
            stage: stage++,
            title: "Set up Food Service",
            description: "Add a menu item when you are ready to offer food service.",
            href: "/owner/menu?create=1",
            classification: "recommended",
            completed: counts.menuItemCount > 0
        });
    }

    if (!isAccommodation) {
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

    tasks.push({
        id: "payments_offline",
        stage: stage++,
        title: "Set up offline payments",
        description: "Add a card to receive offline commission invoices.",
        href: "/owner/billing?action=add-card",
        // A saved billing card enables staff offline-payment operations, but
        // must not make Stripe-less hotels ineligible for all reservations.
        classification: "recommended",
        completed: offlinePaymentsConfigured
    });

    tasks.push({
        id: "payments_online",
        stage: stage++,
        title: "Set up online payments",
        description: "Connect your bank to receive online payments.",
        href: "/owner/billing?tab=payouts",
        classification: isAccommodation ? "required" : "recommended",
        completed: stripeConnected
    });

    if (isAccommodation) {
        const previewHref = getStayPreviewHref(business)
        if (previewHref) {
            tasks.push({
                id: "booking_preview",
                stage: stage++,
                title: "Preview your booking page",
                description: "See how guests will experience booking your accommodation.",
                href: previewHref,
                classification: "recommended",
                completed: false,
            })
        }

    }

    return tasks;
}

export function buildSetupProgressResponse(business, counts, capabilities) {
    const tasks = buildSetupTasks(business, counts, capabilities);

    const requiredTasks = tasks.filter(t => t.classification === "required");
    const completedRequiredCount = requiredTasks.filter(t => t.completed).length;
    
    const recommendedTasks = tasks.filter(t => t.classification !== "required");
    const completedRecommendedCount = recommendedTasks.filter(t => t.completed).length;
    const totalCoreCount = requiredTasks.length;
    const completedCoreCount = completedRequiredCount;
    const complete = completedRequiredCount === requiredTasks.length;
    const bookingReadiness = buildAccommodationBookingReadiness(business, capabilities);
    
    let nextAction = null;
    for (const task of requiredTasks) {
        if (!task.completed) {
            nextAction = task;
            break;
        }
    }

    return {
        title: "Setup Progress",
        subtitle: capabilities.visibleModules.includes("lodging")
            ? "Get Ready to Welcome Guests"
            : "Get Ready to Accept Orders",
        tasks,
        nextAction,
        completedRequiredCount,
        totalRequiredCount: requiredTasks.length,
        completedCoreCount,
        totalCoreCount,
        completedRecommendedCount,
        totalRecommendedCount: recommendedTasks.length,
        progressPercent: requiredTasks.length === 0 ? 100 : Math.round((completedRequiredCount / requiredTasks.length) * 100),
        complete,
        completionMessage: capabilities.visibleModules.includes("lodging")
            ? "Your Chillow workspace is ready. Review your public booking settings to start welcoming reservations."
            : "Your Chillow workspace is ready to accept orders.",
        bookingReadiness: bookingReadiness
            ? { ...bookingReadiness, operationalSetupComplete: complete }
            : null,
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
        roomCount,
        readyRoomCount,
        staffCount,
    ] = await Promise.all([
        MenuItem.countDocuments({ businessId }),
        ServicePoint.countDocuments({ businessId }),
        ServicePoint.countDocuments({ businessId, servicePointType: "room" }),
        ServicePoint.countDocuments({
            businessId,
            servicePointType: "room",
            isActive: { $ne: false },
            reservable: { $ne: false },
            pricePerNight: { $gt: 0 },
            maxGuests: { $gt: 0 },
            $or: [
                { "roomReadiness.state": "ready" },
                { roomReadiness: { $exists: false } },
                { roomReadiness: null },
            ],
        }),
        Staff.countDocuments({ businessId, accountStatus: { $ne: "disabled" } }),
    ]);

    const counts = {
        menuItemCount,
        servicePointCount,
        roomCount,
        readyRoomCount,
        staffCount,
        publicStayReservationsEnabled: getConfiguredPublicReservationModes(business).includes("stay"),
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

        const completedAt = new Date()
        await Business.updateOne(
            { businessId },
            withReservationEligibilityFence({
                $set: {
                    "setupProgress.setupGuideDismissed": true,
                    "setupProgress.setupGuideDismissedAt": completedAt,
                    onboardingCompleted: true,
                    onboardingCompletedAt: completedAt,
                    onboardingCompletionAudit: {
                        source: "self_service_setup",
                        completedAt,
                    },
                },
            }, completedAt),
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
