import Business from "../models/Business.js";
import Reservation, { timeStringToMinutes, MIN_DURATION_MINUTES } from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import { sendReservationRequestEmail, sendReservationRequestReceivedEmail } from "../utils/emailService.js";
import { buildReservationPricingSnapshot } from "../services/reservationPricingService.js";
import { dispatchRestaurantReservationEmail } from "../services/email/emailDispatchService.js";
import { validateReservationGuestCapacity } from "../services/reservationCapacityService.js";
import { EMAIL_JOB_NAMES } from "../queues/index.js";
import {
  RESTAURANT_AVAILABILITY_POLICIES,
  getRestaurantAvailability,
} from "../services/restaurantReservationAvailabilityService.js";
import {
  CACHE_TTL_SECONDS,
  cacheKeys,
  responseCache,
} from "../services/responseCacheService.js";
import {
  PUBLIC_RESERVATION_LINK_ERROR,
  PublicReservationAccessError,
  resolveReservationConfirmationAccess,
  resolveReservationPaymentAccess,
} from "../services/reservationPublicAccessService.js";
import {
  PUBLIC_SERVABLE_BUSINESS_STATUSES,
  PublicBusinessResolutionError,
  normalizePublicBusinessLocator,
  resolvePublicBusiness,
} from "../services/publicBusinessResolverService.js";

import { assertReservationEligibility } from "../services/reservationEligibilityService.js";
import {
  assertPublicReservationModeBookable,
  getPublicReservationBookability,
  resolvePublicReservationMode,
} from "../services/publicReservationBookabilityService.js";
const RESERVATION_CONFIRMATION_SESSION_HEADER =
  "x-reservation-confirmation-session";
const PUBLIC_BUSINESS_FIELDS = new Set([
  "businessId", "slug", "name", "displayName", "address", "phoneNumber",
  "country", "currency", "timezone", "logoUrl", "branding", "operatingHours",
  "settings", "hotelSettings", "businessType", "venueType", "modules", "servicePoints",
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

function setPrivateNoStore(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
}

function publicReservationAccessError(res) {
  return res.status(404).json({
    error: PUBLIC_RESERVATION_LINK_ERROR,
  });
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

    if (!business || !PUBLIC_SERVABLE_BUSINESS_STATUSES.includes(business.status)) {
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
      countryCode: business.countryCode, 
      currency: business.currency,
      timezone: business.timezone,
      language: business.language,
      businessType: business.businessType,
      venueType: business.venueType || null,
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
    const {
      businessSlug: normalizedSlug,
      countryCode: normalizedCountryCode,
    } = normalizePublicBusinessLocator({ businessSlug: slug, countryCode });

    const cacheKey = cacheKeys.publicBusiness(normalizedCountryCode, normalizedSlug);
    const cached = await responseCache.get(cacheKey);
    if (cached.hit && isSafePublicBusinessDto(cached.value, normalizedSlug)) {
      return res.json(cached.value);
    }

    const { business } = await resolvePublicBusiness({
      businessSlug: normalizedSlug,
      countryCode: normalizedCountryCode,
    });

    if (!business) return res.status(404).json({ error: "Business not found" });

    if (!PUBLIC_SERVABLE_BUSINESS_STATUSES.includes(business.status)) {
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
      venueType: business.venueType || null,
      modules: business.modules,
      servicePoints: servicePoints,
    };

    await responseCache.set(
      cacheKey,
      publicDto,
      CACHE_TTL_SECONDS.TENANT_STABLE,
    );

    return res.json(publicDto);
  } catch (error) {
    if (error instanceof PublicBusinessResolutionError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[publicController.getBusinessBySlug] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservation-options/:countryCode/:slug
 * Returns only public, currently enabled booking modes. It intentionally does
 * not disclose internal configuration, ServicePoints, or readiness details.
 */
export async function getPublicReservationOptions(req, res, {
  resolveBusinessRequest = resolvePublicBusiness,
} = {}) {
  try {
    const { business } = await resolveBusinessRequest({
      businessSlug: req.params.slug,
      countryCode: req.params.countryCode,
      statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    });
    if (!business) return res.status(404).json({ error: "Business not found" });

    const { modes } = getPublicReservationBookability(business);
    res.set({ "Cache-Control": "private, no-store, max-age=0" });
    return res.json({ modes });
  } catch (error) {
    if (error instanceof PublicBusinessResolutionError || error.statusCode) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    console.error("[publicController.getPublicReservationOptions] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

import {
  createReservationService,
  normalizeCreationIdempotencyKey,
} from "../services/reservationCreationService.js";
// backward-compat alias – publicController still references this name
const normalizeRestaurantCreationIdempotencyKey = normalizeCreationIdempotencyKey;

async function createExternalReservationNotification(...args) {
  const { notifyExternalReservationCreated } = await import(
    "../services/reservationNotificationService.js"
  );
  return notifyExternalReservationCreated(...args);
}

/**
 * Handles new public reservation requests.
 */
export async function createReservation(req, res, {
  createReservationRequest = createReservationService,
  notifyExternalReservation = createExternalReservationNotification,
  resolveBusinessRequest = resolvePublicBusiness,
} = {}) {
  try {
    const {
      isHotelBooking,
      reservationMode,
      businessSlug,
      countryCode,
      customerName,
      phone,
      email,
      guestCount,
      servicePointId,
      specialRequest,
      checkInDate,
      checkOutDate,
      date,
      startTime,
      endTime,
      durationMinutes,
      seatingPreference,
    } = req.body || {};
    const rawKey = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
    // ARCH-006: idempotency applies to both hotel and restaurant public bookings
    const idempotencyKey = rawKey
      ? normalizeCreationIdempotencyKey(rawKey)
      : null;
    const hasStayFields = [checkInDate, checkOutDate].some((value) => value !== undefined && value !== null && value !== "");
    const hasTimeslotFields = [date, startTime, endTime].some((value) => value !== undefined && value !== null && value !== "");
    const { business } = await resolveBusinessRequest({
      businessSlug,
      countryCode,
      statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    });
    if (!business) {
      return res.status(404).json({ error: "Business not found or inactive" });
    }
    const resolvedReservationMode = resolvePublicReservationMode({
      business,
      reservationMode,
      isHotelBooking,
      hasStayFields,
      hasTimeslotFields,
    });
    const isStayBooking = resolvedReservationMode === "stay";

    if (!isStayBooking && servicePointId != null && typeof servicePointId !== "string") {
      return res.status(400).json({ error: "A valid ServicePoint ID is required." });
    }
    const requestedRestaurantServicePointId = !isStayBooking && servicePointId
      ? servicePointId.trim() || null
      : null;
    assertReservationEligibility(business);
    const result = await createReservationRequest({
      isHotelBooking: isStayBooking,
      businessSlug: business.slug,
      countryCode: business.countryCode,
      business,
      customerName,
      phone,
      email,
      guestCount,
      // A guest selection is a request only. Restaurant creation independently
      // validates and locks it through the canonical transactional allocator.
      servicePointId: isStayBooking
        ? servicePointId
        : requestedRestaurantServicePointId,
      specialRequest,
      checkInDate,
      checkOutDate,
      date,
      startTime,
      endTime,
      durationMinutes,
      seatingPreference: isStayBooking ? seatingPreference : "no_preference",
      source: "online",
      idempotencyKey,
    });

    if (!result.replayed) try {
      await notifyExternalReservation({ reservation: result.reservation });
    } catch (notificationError) {
      console.error("[publicController.createReservation] Notification intent failed", {
        reservationId: String(result.reservationId || ""),
        errorClass: notificationError?.name || "Error",
      });
    }

    // Build safe public DTO — never expose full reservation internals
    const dto = {
      message: result.message,
      reservationId: result.reservationId,
      pricing: result.pricing,
      bookingMode: result.bookingMode,
      reservationMode: resolvedReservationMode,
    };

    // For instant bookings, include the secureToken so the frontend
    // can immediately call /payments/checkout-reservation
    if (result.bookingMode === "instant" && result.reservation?.secureToken) {
      dto.secureToken = result.reservation.secureToken;
    }

    return res.status(result.replayed ? 200 : 201).json(dto);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[publicController.createReservation] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/restaurant-availability
 * Public policy wrapper around the canonical restaurant availability engine.
 */
export async function getPublicRestaurantAvailability(req, res) {
  try {
    const businessSlug = String(req.query.businessSlug || "").trim().toLowerCase();
    const countryCode = String(req.query.countryCode || "").trim().toLowerCase();
    if (!businessSlug) {
      return res.status(400).json({ error: "businessSlug is required" });
    }

    const { business } = await resolvePublicBusiness({
      businessSlug,
      countryCode,
      statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    });
    if (!business) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    // Keep the established public availability response for the legacy global
    // switch while the mode resolver governs all additive per-mode settings.
    if (business.settings?.reservationsEnabled === false) {
      return res.status(403).json({ error: "Reservations are disabled for this business" });
    }
    assertPublicReservationModeBookable(business, "timeslot");

    const availability = await getRestaurantAvailability({
      businessId: business.businessId,
      business,
      date: req.query.date,
      month: req.query.month,
      partySize: req.query.partySize,
      durationMinutes: req.query.durationMinutes,
      startTime: req.query.startTime || undefined,
      servicePointId: req.query.servicePointId || undefined,
      policy: RESTAURANT_AVAILABILITY_POLICIES.public,
    });

    return res.json(availability);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[publicController.getPublicRestaurantAvailability] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/by-token/:secureToken
 * Fetch a reservation by its secure token (used for the payment flow).
 * Only returns safe, customer-facing fields.
 */
export async function getReservationByToken(req, res) {
  setPrivateNoStore(res);
  try {
    const result = await resolveReservationPaymentAccess({
      secureToken: req.params?.secureToken,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PublicReservationAccessError) {
      return publicReservationAccessError(res);
    }
    console.error("[publicController.getReservationByToken] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /public/reservations/by-id/:reservationId
 * Fetch the strict confirmation DTO only when the reservation-bound Stripe
 * Checkout Session capability is supplied in a request header.
 */
export async function getReservationById(req, res) {
  setPrivateNoStore(res);
  try {
    const checkoutSessionId =
      req.get?.(RESERVATION_CONFIRMATION_SESSION_HEADER) ||
      req.headers?.[RESERVATION_CONFIRMATION_SESSION_HEADER];
    const result = await resolveReservationConfirmationAccess({
      reservationId: req.params?.reservationId,
      checkoutSessionId,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PublicReservationAccessError) {
      return publicReservationAccessError(res);
    }
    console.error("[publicController.getReservationById] Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}

export { RESERVATION_CONFIRMATION_SESSION_HEADER, setPrivateNoStore };
