import Business from "../models/Business.js";
import Reservation, { timeStringToMinutes, MIN_DURATION_MINUTES } from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import { sendReservationRequestEmail, sendReservationRequestReceivedEmail } from "../utils/emailService.js";
import { getCustomerReservationPricing, buildReservationPricingSnapshot } from "../services/reservationPricingService.js";

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
      hotelSettings: business.hotelSettings,
      businessType: business.businessType,
      modules: business.modules,
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
      // Hotel-specific
      checkInDate,
      checkOutDate,
      isHotelBooking,
    } = req.body;

    // ── HOTEL BOOKING PATH ────────────────────────────────────────────────────
    if (isHotelBooking) {
      if (!businessSlug || !customerName || !phone || !email || !checkInDate || !checkOutDate || !guestCount || !servicePointId) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (checkOutDate <= checkInDate) {
        return res.status(400).json({ error: "Check-out must be after check-in." });
      }

      if (checkInDate < new Date().toISOString().split("T")[0]) {
        return res.status(400).json({ error: "Check-in date cannot be in the past." });
      }

      const guests = parseInt(guestCount, 10);
      if (isNaN(guests) || guests < 1 || guests > 50) {
        return res.status(400).json({ error: "Guest count must be between 1 and 50." });
      }

      if (specialRequest && specialRequest.length > 500) {
        return res.status(400).json({ error: "Special request is too long (max 500 characters)." });
      }

      const business = await Business.findOne({
        slug: businessSlug.toLowerCase(),
        status: { $in: ["active", "onboarding", "draft"] },
      }).lean();
      if (!business) {
        return res.status(404).json({ error: "Business not found or inactive" });
      }

      // Look up the service point — authoritative source for pricePerNight
      const sp = await ServicePoint.findOne({
        servicePointId,
        businessId: business.businessId,
        isActive: { $ne: false },
        reservable: { $ne: false },
      }).lean();
      if (!sp) {
        return res.status(400).json({ error: "The selected room is not available for booking." });
      }

      // Capacity check
      if (sp.capacity != null && guests > sp.capacity) {
        return res.status(400).json({ error: `This room accommodates a maximum of ${sp.capacity} guests.` });
      }

      // Conflict check — no overlapping confirmed/pending reservations for the same service point
      const conflict = await Reservation.findOne({
        businessId: business.businessId,
        servicePointId,
        status: { $in: ["confirmed", "pending", "accepted_awaiting_payment", "checked_in"] },
        checkInDate:  { $lt: checkOutDate },
        checkOutDate: { $gt: checkInDate },
      }).lean();
      if (conflict) {
        return res.status(409).json({ error: "This room is already booked for the selected dates." });
      }

      // Compute nights and authoritative pricing
      const msPerDay = 1000 * 60 * 60 * 24;
      const numberOfNights = Math.round((new Date(checkOutDate) - new Date(checkInDate)) / msPerDay);
      const pricePerNight = sp.pricePerNight || 0;

      const hotelReservation = new Reservation({
        businessId: business.businessId,
        businessSlug: business.slug,
        customerName,
        phone,
        email,
        checkInDate,
        checkOutDate,
        guestCount: guests,
        servicePointId: sp.servicePointId,
        servicePointLabel: sp.displayLabel || sp.label,
        specialRequest,
        pricePerNight,
        numberOfNights,
        currency: business.currency || "eur",
        status: "pending",
        source: "public_hub",
      });

      // Build authoritative pricing snapshot
      try {
        const snapshot = await buildReservationPricingSnapshot({ reservation: hotelReservation, business });
        Object.assign(hotelReservation, snapshot);
      } catch (pricingErr) {
        console.error("[createReservation] Pricing snapshot failed:", pricingErr);
        // Non-fatal: save without snapshot, it can be recomputed later
      }

      await hotelReservation.save();

      const reservationObj = hotelReservation.toObject();
      const businessDisplayName = business.displayName || business.name;
      const targetEmail = business.contactEmail || business.ownerEmail;

      if (targetEmail) {
        sendReservationRequestEmail({
          to: targetEmail,
          businessName: businessDisplayName,
          reservation: reservationObj,
        }).catch(err => console.error("[createReservation hotel] Owner email failed:", err));
      }
      if (reservationObj.email) {
        sendReservationRequestReceivedEmail({
          to: reservationObj.email,
          businessName: businessDisplayName,
          businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
          primaryColor: business.branding?.primaryColor,
          reservation: reservationObj,
        }).catch(err => console.error("[createReservation hotel] Customer email failed:", err));
      }

      return res.status(201).json({
        message: "Hotel booking request received.",
        reservationId: hotelReservation._id,
        // Canonical CustomerPricingBreakdown DTO consumed by HotelPricingBreakdown on the
        // Booking Request Sent screen. Field names must match the TypeScript interface.
        pricing: getCustomerReservationPricing(hotelReservation),
      });
    }

    // ── RESTAURANT / BAR BOOKING PATH ─────────────────────────────────────────
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
      .select("-stripeSessionId -paymentExpiresAt")
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
