import Business from "../models/Business.js";
import Reservation, { timeStringToMinutes, MIN_DURATION_MINUTES } from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import { sendReservationRequestEmail, sendReservationRequestReceivedEmail } from "../utils/emailService.js";

const SERVABLE_STATUSES = ["active", "onboarding", "draft"];

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
    const businessId = req.query.businessId || req.query.restaurantId;
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" });
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
      business.billingStatus === "active" && !!business.defaultPaymentMethodId;

    return res.json({
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
    });
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

    let business;
  

    if (countryCode) {
      business = await Business.findOne({ slug: slug.toLowerCase(), countryCode: countryCode.toLowerCase() }).lean();
    } else {
      // Legacy route: find all matching slugs
      const businesses = await Business.find({ slug: slug.toLowerCase() }).lean();
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
    }).select("servicePointId label capacity").lean();

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
      servicePoints: servicePoints,
    };

    res.json(publicDto);
  } catch (error) {
    console.error("[publicController.getBusinessBySlug] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Handles new public reservation requests.
 */
export async function createReservation(req, res) {
  try {
    const {
      businessSlug,
      customerName,
      phone,
      email,
      date,
      startTime,
      endTime,
      durationMinutes,
      guestCount,
      seatingPreference,
      servicePointId,
      servicePointLabel,
      specialRequest,
    } = req.body;

    if (!businessSlug || !customerName || !phone || !email || !date || !startTime || !endTime || !guestCount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const startMinutes = timeStringToMinutes(startTime);
    const endMinutes = timeStringToMinutes(endTime);
    if (Number.isNaN(startMinutes) || Number.isNaN(endMinutes)) {
      return res.status(400).json({ error: "startTime and endTime must be valid HH:MM values" });
    }
    if (endMinutes <= startMinutes) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    // The start/end range is the source of truth for duration. If a client also
    // sends durationMinutes, it must agree with the range.
    const duration = endMinutes - startMinutes;
    if (durationMinutes != null && Number(durationMinutes) !== duration) {
      return res.status(400).json({ error: "durationMinutes does not match the start/end time range" });
    }
    if (duration < MIN_DURATION_MINUTES) {
      return res.status(400).json({ error: "Duration must be at least 30 minutes" });
    }

    // Guest count validation
    const guests = parseInt(guestCount, 10);
    if (isNaN(guests) || guests < 1 || guests > 50) {
      return res.status(400).json({ error: "Guest count must be between 1 and 50" });
    }

    // Special request length validation
    if (specialRequest && specialRequest.length > 500) {
      return res.status(400).json({ error: "Special request is too long (max 500 characters)" });
    }

    // Date/Time validation (reject past dates)
    const [year, month, day] = date.split("-").map(Number);
    const [hours, minutes] = startTime.split(":").map(Number);
    
    if (!year || isNaN(month) || isNaN(day) || isNaN(hours) || isNaN(minutes)) {
      return res.status(400).json({ error: "Invalid date or time format" });
    }

    const reservationDate = new Date(year, month - 1, day, hours, minutes);
    if (reservationDate < new Date()) {
      return res.status(400).json({ error: "Reservation cannot be in the past" });
    }

    const business = await Business.findOne({ 
      slug: businessSlug.toLowerCase(), 
      status: { $in: ["active", "onboarding", "draft"] } 
    }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found or inactive" });
    }

    if (business.settings?.reservationsEnabled === false) {
      return res.status(403).json({ error: "Reservations are currently disabled for this business." });
    }

    // Operating hours validation
    const dayOfWeek = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long' });
    const dayConfig = business.operatingHours?.[dayOfWeek];
    if (!dayConfig || !dayConfig.enabled) {
      return res.status(400).json({ error: "Reservations are only available during business hours." });
    }
    if (startTime < dayConfig.openTime || endTime > dayConfig.closeTime) {
      return res.status(400).json({ error: "Reservations are only available during business hours." });
    }

    // Validate + conflict-check for specific service points
    if (servicePointId) {
      // The point must actually belong to this business and be reservable/active.
      const sp = await ServicePoint.findOne({
        servicePointId,
        businessId: business.businessId,
        isActive: { $ne: false },
        reservable: { $ne: false },
      }).lean();
      if (!sp) {
        return res.status(400).json({ error: "The selected service point is not available for reservations." });
      }

      const existingReservation = await Reservation.findOne({
        businessId: business.businessId,
        servicePointId,
        date,
        status: "confirmed",
        startTime: { $lt: endTime },
        endTime: { $gt: startTime }
      }).lean();
      
      if (existingReservation) {
        return res.status(409).json({ error: "This place is already booked for the selected date and time." });
      }
    }

    // Create reservation
    const reservation = new Reservation({
      businessId: business.businessId,
      businessSlug: business.slug,
      customerName,
      phone,
      email,
      date,
      time: startTime, // legacy support
      startTime,
      endTime,
      durationMinutes: duration,
      guestCount: guests,
      seatingPreference,
      servicePointId,
      servicePointLabel,
      specialRequest,
      status: "pending",
      source: "public_hub",
    });

    await reservation.save();

    // Emails are fire-and-forget: never block the response or fail the request.
    const reservationObj = reservation.toObject();
    const businessDisplayName = business.displayName || business.name;

    // 1. Notify the business owner of the new request.
    const targetEmail = business.contactEmail || business.ownerEmail;
    if (targetEmail) {
      sendReservationRequestEmail({
        to: targetEmail,
        businessName: businessDisplayName,
        reservation: reservationObj
      }).catch(err => console.error("[createReservation] Owner email failed to send:", err));
    }

    // 2. Notify the customer their request was received (only if they gave an email).
    if (reservationObj.email) {
      sendReservationRequestReceivedEmail({
        to: reservationObj.email,
        businessName: businessDisplayName,
        businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
        primaryColor: business.branding?.primaryColor,
        reservation: reservationObj
      }).catch(err => console.error("[createReservation] Customer email failed to send:", err));
    }

    res.status(201).json({
      message: "Reservation request received.",
      reservationId: reservation._id
    });
  } catch (error) {
    console.error("[publicController.createReservation] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}
