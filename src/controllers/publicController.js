import Business from "../models/Business.js";
import Reservation from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import { sendReservationRequestEmail } from "../utils/emailService.js";

/**
 * Returns a sanitized public DTO for the business hub.
 */
export async function getBusinessBySlug(req, res) {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: "Slug is required" });

    const business = await Business.findOne({ slug: slug.toLowerCase() }).lean();
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

    if (!businessSlug || !customerName || !phone || !date || !startTime || !endTime || !guestCount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (startTime >= endTime) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    const duration = durationMinutes || 120;
    if (duration < 30 || duration > 240) {
      return res.status(400).json({ error: "Duration must be between 30 minutes and 4 hours" });
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

    // Conflict check for specific service points
    if (servicePointId) {
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

    // Send email (async, do not block response, don't fail if email fails)
    const targetEmail = business.contactEmail || business.ownerEmail;
    if (targetEmail) {
      sendReservationRequestEmail({
        to: targetEmail,
        businessName: business.displayName || business.name,
        reservation: reservation.toObject()
      }).catch(err => console.error("[createReservation] Email failed to send:", err));
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
