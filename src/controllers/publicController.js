import Business from "../models/Business.js";
import Reservation, { timeStringToMinutes, MIN_DURATION_MINUTES } from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import { sendReservationRequestEmail, sendReservationRequestReceivedEmail } from "../utils/emailService.js";
import { getCustomerReservationPricing, buildReservationPricingSnapshot } from "../services/reservationPricingService.js";
import { dispatchRestaurantReservationEmail } from "../services/email/emailDispatchService.js";
import { validateReservationGuestCapacity } from "../services/reservationCapacityService.js";
import { EMAIL_JOB_NAMES } from "../queues/index.js";
import {
  CACHE_TTL_SECONDS,
  cacheKeys,
  responseCache,
} from "../services/responseCacheService.js";

const SERVABLE_STATUSES = ["active", "onboarding", "draft"];
const PUBLIC_BUSINESS_FIELDS = new Set([
  "businessId", "slug", "name", "displayName", "address", "phoneNumber",
  "country", "currency", "timezone", "logoUrl", "branding", "operatingHours",
  "settings", "hotelSettings", "businessType", "modules", "servicePoints",
]);
const PUBLIC_SERVICE_POINT_FIELDS = new Set([
  "_id", "servicePointId", "label", "servicePointType", "roomType", "capacity",
  "pricePerNight", "currency", "description", "fullDescription", "amenities",
  "images", "beds", "bedType", "bedConfiguration", "viewType", "maxGuests",
]);

function isSafePublicBusinessDto(value, expectedSlug) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.businessId === "string" &&
    typeof value.slug === "string" &&
    value.slug.toLowerCase() === expectedSlug &&
    Array.isArray(value.servicePoints) &&
    Object.keys(value).every(field => PUBLIC_BUSINESS_FIELDS.has(field)) &&
    value.servicePoints.every(servicePoint =>
      servicePoint &&
      typeof servicePoint === "object" &&
      !Array.isArray(servicePoint) &&
      Object.keys(servicePoint).every(field => PUBLIC_SERVICE_POINT_FIELDS.has(field))
    )
  );
}

/**
 * GET /public/business-config?businessId=...
 *
 * Public, UNauthenticated business configuration for the customer ordering app
 * (and non-manager staff like waiters). Returns ONLY safe, public-facing config —
 * never owner, billing, Stripe, or any credential fields.
 *
 * This is deliberately separate from the authenticated GET /business/settings,
 * which returns the full document to managers/owners only.
 */
export async function getPublicBusinessConfig(req, res) {
  try {
    const canonicalBusinessId = req.query.businessId;
    const businessId = canonicalBusinessId || req.query.restaurantId;
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" });
    }

    if (canonicalBusinessId) {
      const requestedCacheKey = cacheKeys.publicBusinessConfig(canonicalBusinessId);
      const cached = await responseCache.get(requestedCacheKey);
      if (
        cached.hit &&
        cached.value &&
        typeof cached.value === "object" &&
        !Array.isArray(cached.value) &&
        cached.value.businessId === canonicalBusinessId
      ) {
        return res.json(cached.value);
      }
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    }).lean();

    if (!business || !SERVABLE_STATUSES.includes(business.status)) {
      return res.status(404).json({ error: "Business not found" });
    }

    // Plan-derived values (same logic as authenticated getSettings)
    const currentPlan = business.currentPlan || "basic";
    const planDef = await Plan.findOne({ slug: currentPlan }).lean();
    const platformFeeRate = planDef ? planDef.offlineCommissionRate : 2.5;

    const canUseBranding = ["growth", "pro"].includes(currentPlan);
    const canRemoveQuickServeBranding = currentPlan === "pro";

    let branding = canUseBranding ? business.branding || null : null;
    if (branding && !canRemoveQuickServeBranding) {
      branding = { ...branding, removeQuickServeBranding: false };
    }

    // Offline availability as a boolean only — never expose the underlying billing details.
    const offlinePaymentsAvailable =
      business.billingStatus === "active" &&
      business.offlineServiceRestricted !== true &&
      !!business.defaultPaymentMethodId;

    const publicConfig = {
      businessId: business.businessId,
      name: business.name,
      displayName: business.displayName,
      slug: business.slug,
      logoUrl: business.logoUrl,
      phoneNumber: business.phoneNumber,
      address: business.address,
      country: business.country,
      currency: business.currency,
      timezone: business.timezone,
      language: business.language,
      businessType: business.businessType,
      taxRate: business.taxRate,
      passPlatformFeeToCustomer: business.passPlatformFeeToCustomer,
      platformFeeMode: business.platformFeeMode || "business_absorbs",
      customerPlatformFeePercent: business.customerPlatformFeePercent || 0,
      platformFeeLabel: business.platformFeeLabel,
      platformFeeRate,
      offlinePaymentsAvailable,
      operatingHours: business.operatingHours,
      orderingPreferences: business.orderingPreferences,
      paymentPreferences: business.paymentPreferences,
      settings: business.settings,
      menuCategories: business.menuCategories,
      branding,
      brandingAccess: { canUseBranding, canRemoveQuickServeBranding },
    };

    // Only populate a key built from the canonical ID returned by MongoDB. A
    // legacy restaurantId lookup remains supported but intentionally does not
    // create an alias key that could weaken tenant-key isolation.
    await responseCache.set(
      cacheKeys.publicBusinessConfig(business.businessId),
      publicConfig,
      CACHE_TTL_SECONDS.TENANT_STABLE,
    );

    return res.json(publicConfig);
  } catch (error) {
    console.error("[publicController.getPublicBusinessConfig] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Returns a sanitized public DTO for the business hub.
 */
export async function getBusinessBySlug(req, res) {
  try {
    const { slug, countryCode } = req.params;
    if (!slug) return res.status(400).json({ error: "Slug is required" });

    const normalizedSlug = slug.trim().toLowerCase();
    const normalizedCountryCode = countryCode?.trim().toLowerCase();
    if (!normalizedSlug) return res.status(400).json({ error: "Slug is required" });

    if (normalizedCountryCode) {
      const cacheKey = cacheKeys.publicBusiness(normalizedCountryCode, normalizedSlug);
      const cached = await responseCache.get(cacheKey);
      if (cached.hit && isSafePublicBusinessDto(cached.value, normalizedSlug)) {
        return res.json(cached.value);
      }
    }

    let business;


    if (normalizedCountryCode) {
      business = await Business.findOne({ slug: normalizedSlug, countryCode: normalizedCountryCode }).lean();
    } else {
      // Legacy route: find all matching slugs
      const businesses = await Business.find({ slug: normalizedSlug }).lean();
      if (businesses.length === 1) {
        business = businesses[0];
        redirectUrl = `/b/${business.countryCode || 'mt'}/${business.slug}`;
      } else if (businesses.length > 1) {
        return res.status(300).json({
          error: "Multiple businesses found. Please use the country-specific link.",
          redirects: businesses.map(b => `/b/${b.countryCode || 'mt'}/${b.slug}`)
        });
      }
    }

    if (!business) return res.status(404).json({ error: "Business not found" });

    if (!["active", "onboarding", "draft"].includes(business.status)) {
      return res.status(404).json({ error: "Business is not available" });
    }


    const servicePoints = await ServicePoint.find({
      businessId: business.businessId,
      isActive: { $ne: false },
      reservable: { $ne: false }
    })
      .select([
        "servicePointId",
        "label",
        "servicePointType",
        "roomType",
        "capacity",
        "pricePerNight",
        "currency",
        "description",
        "fullDescription",
        "amenities",
        "images",
        "beds",
        "bedType",
        "bedConfiguration",
        "viewType",
        "maxGuests",
      ].join(" "))
      .lean();

    const publicDto = {
      businessId: business.businessId,
      slug: business.slug,
      name: business.name,
      displayName: business.displayName,
      address: business.address,
      phoneNumber: business.phoneNumber,
      country: business.country,
      currency: business.currency,
      timezone: business.timezone,
      logoUrl: business.logoUrl,
      branding: business.branding,
      operatingHours: business.operatingHours,
      settings: business.settings, // things like dineInEnabled etc.
      hotelSettings: business.hotelSettings,
      businessType: business.businessType,
      modules: business.modules,
      servicePoints: servicePoints,
    };

    if (normalizedCountryCode) {
      await responseCache.set(
        cacheKeys.publicBusiness(normalizedCountryCode, normalizedSlug),
        publicDto,
        CACHE_TTL_SECONDS.TENANT_STABLE,
      );
    }

    return res.json(publicDto);
  } catch (error) {
    console.error("[publicController.getBusinessBySlug] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

import { createReservationService } from "../services/reservationCreationService.js";

/**
 * Handles new public reservation requests.
 */
export async function createReservation(req, res) {
  try {
    const result = await createReservationService({
      ...req.body,
      source: "online",
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[publicController.createReservation] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/by-token/:secureToken
 * Fetch a reservation by its secure token (used for the payment flow).
 * Only returns safe, customer-facing fields.
 */
export async function getReservationByToken(req, res) {
  try {
    const { secureToken } = req.params;
    if (!secureToken) {
      return res.status(400).json({ error: "secureToken is required" });
    }

    const reservation = await Reservation.findOne({ secureToken })
      .select("-stripeSessionId")
      .lean();
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const business = await Business.findOne({ businessId: reservation.businessId })
      .select("businessId name displayName logoUrl currency country countryCode slug")
      .lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const pricing = getCustomerReservationPricing(reservation);

    // Strip internal fields before sending to client
    delete reservation.secureToken;
    delete reservation.stripeCheckoutSessionId;
    delete reservation.stripePaymentIntentId;
    delete reservation.stripeConnectedAccountId;
    delete reservation.platformFeeCents;
    delete reservation.businessAbsorbedPlatformFeeCents;
    delete reservation.platformFeeMode;
    delete reservation.customerPlatformFeePercent;
    delete reservation.planApplied;
    delete reservation.commissionRateApplied;
    delete reservation.commissionAmountCents;
    delete reservation.planAtOrder;
    delete reservation.commissionRateAtOrder;
    delete reservation.platformFeeRateAtOrder;
    delete reservation.grossAmount;
    delete reservation.netToBusinessAmount;
    delete reservation.amountPaidCents;

    res.json({ reservation: { ...reservation, pricing }, business });
  } catch (error) {
    console.error("[publicController.getReservationByToken] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/by-id/:reservationId
 * Fetch a reservation by its MongoDB _id for the confirmation page (post-payment).
 * Only returns safe fields; does NOT expose secureToken.
 */
export async function getReservationById(req, res) {
  try {
    const { reservationId } = req.params;
    if (!reservationId) {
      return res.status(400).json({ error: "reservationId is required" });
    }

    const reservation = await Reservation.findById(reservationId)
      .select("-secureToken -stripeSessionId -paymentExpiresAt")
      .lean();
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const business = await Business.findOne({ businessId: reservation.businessId })
      .select("businessId name displayName logoUrl currency country countryCode slug")
      .lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const pricing = getCustomerReservationPricing(reservation);
    delete reservation.stripeCheckoutSessionId;
    delete reservation.stripePaymentIntentId;
    delete reservation.stripeConnectedAccountId;
    delete reservation.platformFeeCents;
    delete reservation.businessAbsorbedPlatformFeeCents;
    delete reservation.platformFeeMode;
    delete reservation.customerPlatformFeePercent;
    delete reservation.planApplied;
    delete reservation.commissionRateApplied;
    delete reservation.commissionAmountCents;
    delete reservation.planAtOrder;
    delete reservation.commissionRateAtOrder;
    delete reservation.platformFeeRateAtOrder;
    delete reservation.grossAmount;
    delete reservation.netToBusinessAmount;
    delete reservation.amountPaidCents;

    res.json({ reservation: { ...reservation, pricing }, business });
  } catch (error) {
    console.error("[publicController.getReservationById] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}
