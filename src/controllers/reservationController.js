import Reservation from "../models/Reservation.js";
import Business from "../models/Business.js";
import { sendReservationConfirmedEmail, sendReservationCancelledEmail } from "../utils/emailService.js";

/**
 * Get reservations for a specific business (Owner authenticated)
 * GET /owner/reservations?businessId=...
 */
export async function getReservations(req, res) {
  try {
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" });
    }

    // Ensure the business belongs to this owner
    const business = await Business.findOne({ businessId, ownerEmail: req.session.user.email }).lean();
    if (!business && req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    // Optional filtering by status, date, etc.
    const { status, date } = req.query;
    const query = { businessId };
    if (status) query.status = status;
    if (date) query.date = date;

    const reservations = await Reservation.find(query).sort({ date: 1, time: 1 }).lean();
    
    res.json(reservations);
  } catch (error) {
    console.error("[reservationController.getReservations] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Update reservation status (Owner authenticated)
 * PATCH /owner/reservations/:id/status
 */
export async function updateReservationStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const reservation = await Reservation.findById(id);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    // Load the business (unscoped) so branding is available for emails and the
    // operating-hours check below works for admins too.
    const business = await Business.findOne({ businessId: reservation.businessId }).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    // Ensure the business belongs to this owner (or the requester is an admin).
    const isOwner = business.ownerEmail === req.session.user.email;
    if (!isOwner && req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    // Basic status validation
    const validStatuses = ["pending", "confirmed", "cancelled", "seated", "completed", "no_show"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Conflict check when confirming
    if (status === "confirmed") {
      // Operating hours validation
      const [year, month, day] = reservation.date.split("-").map(Number);
      const dayOfWeek = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long' });
      const dayConfig = business.operatingHours?.[dayOfWeek];
      
      if (!dayConfig || !dayConfig.enabled || reservation.startTime < dayConfig.openTime || reservation.endTime > dayConfig.closeTime) {
        return res.status(400).json({ error: "Reservations are only available during business hours." });
      }

      if (reservation.servicePointId) {
        const existingReservation = await Reservation.findOne({
          businessId: reservation.businessId,
          servicePointId: reservation.servicePointId,
          date: reservation.date,
          status: "confirmed",
          startTime: { $lt: reservation.endTime },
          endTime: { $gt: reservation.startTime },
          _id: { $ne: reservation._id }
        }).lean();

        if (existingReservation) {
          return res.status(409).json({ error: "This place is already booked and confirmed for the selected time." });
        }
      }
    }

    const previousStatus = reservation.status;
    reservation.status = status;
    await reservation.save();

    const statusChanged = previousStatus !== status;
    let emailStatus = "not_sent";

    if (statusChanged) {
      console.log("[Reservation] Status change:", previousStatus, "->", status);
      
      const reservationObj = reservation.toObject();

      if (!reservationObj.email) {
        console.log("Reservation status changed but no customer email found in DB.", reservationObj);
      } else if (status === "confirmed" || status === "cancelled") {
        console.log("[Reservation Email] Customer email:", reservationObj.email);
        console.log(`[Reservation Email] Sending ${status} email`);

        const emailArgs = {
          to: reservationObj.email,
          businessName: business.displayName || business.name,
          businessLogoUrl: business.branding?.logoUrl || business.logoUrl,
          primaryColor: business.branding?.primaryColor,
          reservation: reservationObj,
        };

        const sender = status === "confirmed" ? sendReservationConfirmedEmail : sendReservationCancelledEmail;
        try {
          console.log("[Reservation Email] Awaiting sender...");
          const success = await sender(emailArgs);
          console.log(`[Reservation Email] Sender returned:`, success);
          if (!success) {
            emailStatus = "failed";
            console.error(`[Reservation Email] Failed to send ${status} email (sender returned false)`);
          } else {
            emailStatus = "sent";
            console.log(`[Reservation Email] Successfully sent ${status} email`);
          }
        } catch (emailError) {
          console.error(`[Reservation Email] Exception in sender for ${status} email:`, emailError);
          emailStatus = "failed";
        }
      }
    }

    res.json({ reservation, emailStatus });
  } catch (error) {
    console.error("[reservationController.updateReservationStatus] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * DELETE /owner/reservations/:id
 */
export async function deleteReservation(req, res) {
  try {
    const { id } = req.params;
    const reservation = await Reservation.findById(id);
    
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    // Ensure the business belongs to this owner
    const business = await Business.findOne({ businessId: reservation.businessId, ownerEmail: req.session.user.email }).lean();
    if (!business && req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to this business" });
    }

    await Reservation.findByIdAndDelete(id);
    res.json({ message: "Reservation deleted successfully" });
  } catch (error) {
    console.error("[reservationController.deleteReservation] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}
