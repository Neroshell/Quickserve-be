import GuestProfile from "../models/GuestProfile.js";
import Business from "../models/Business.js";
import { DateTime } from "luxon";
import { readOwnerGuestsPage, OwnerGuestsCursorError } from "../services/ownerGuestsReadService.js";
import { AnalyticsRangeError } from "../services/analytics/analyticsRangeService.js";
import {
  CrmAnalyticsServiceError,
  crmAnalyticsService,
} from "../services/crmAnalyticsService.js";

export function createCrmAnalyticsController({
  getAnalytics = crmAnalyticsService,
} = {}) {
  return async function getCrmAnalytics(req, res) {
    try {
      const businessId = req.session?.user?.businessId;
      if (!businessId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { range = "30days", from, to } = req.query;
      const analytics = await getAnalytics({
        businessId,
        range,
        from,
        to,
      });
      return res.json(analytics);
    } catch (error) {
      if (
        error instanceof AnalyticsRangeError ||
        error instanceof CrmAnalyticsServiceError
      ) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      console.error("[getCrmAnalytics] Error:", error);
      return res.status(500).json({ error: "Failed to generate CRM analytics" });
    }
  };
}

export const getCrmAnalytics = createCrmAnalyticsController();

/**
 * Get cursor-paginated guest profiles for the authenticated owner's business.
 *
 * Segment → primary sort field mapping (preserving existing semantics):
 *   customers (default) → lastVisitAt DESC
 *   leads               → lastVisitAt DESC
 *   consent_only        → lastVisitAt DESC
 *   no_consent          → lastVisitAt DESC
 *   top_spenders        → totalSpendCents DESC
 *   most_orders         → orderCount DESC
 *   highest_visits      → visitCount DESC
 *   recent              → lastVisitAt DESC
 *   inactive            → lastVisitAt DESC
 *
 * All sorts use _id DESC as the deterministic tiebreaker for cursor pagination.
 * The old offset-based secondary sort (totalSpendCents on most_orders / highest_visits)
 * is replaced by _id to guarantee no duplicates or skipped rows across cursor boundaries.
 */
export async function getGuests(req, res) {
  try {
    const businessId = req.session?.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      cursor,
      direction = "next",
      limit = "25",
      search = "",
      filterBy = "customers",
      dateRange = "all",
      startDate,
      endDate,
    } = req.query;

    // Fetch business for timezone
    const business = await Business.findOne({ $or: [{ businessId }, { businessId: businessId }] }).lean();
    const timezone = business?.timezone || "UTC";

    // Build date-range bounds (requires timezone from Business document)
    let dateRangeBounds = null;
    if (dateRange && dateRange !== "all") {
      const now = DateTime.now().setZone(timezone);
      let startBound, endBound;

      switch (dateRange) {
        case "today":
          startBound = now.startOf("day");
          endBound = now.endOf("day");
          break;
        case "yesterday":
          startBound = now.minus({ days: 1 }).startOf("day");
          endBound = now.minus({ days: 1 }).endOf("day");
          break;
        case "last7":
          startBound = now.minus({ days: 6 }).startOf("day");
          endBound = now.endOf("day");
          break;
        case "thisMonth":
          startBound = now.startOf("month");
          endBound = now.endOf("month");
          break;
        case "custom":
          if (startDate) {
            startBound = DateTime.fromISO(startDate, { zone: timezone }).startOf("day");
          }
          if (endDate) {
            endBound = DateTime.fromISO(endDate, { zone: timezone }).endOf("day");
          }
          break;
      }

      if (startBound || endBound) {
        dateRangeBounds = {
          start: startBound ? startBound.toJSDate() : null,
          end: endBound ? endBound.toJSDate() : null,
        };
      }
    }

    const result = await readOwnerGuestsPage({
      businessId,
      filterBy,
      dateRangeBounds,
      search,
      cursor,
      direction,
      limit: parseInt(limit, 10),
    });

    res.json(result);
  } catch (error) {
    if (error instanceof OwnerGuestsCursorError) {
      return res.status(400).json({ error: error.message });
    }
    console.error("[getGuests] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * Get full details for a single guest
 */
export async function getGuestById(req, res) {
  try {
    const businessId = req.session?.user?.businessId;
    const { guestId } = req.params;

    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const guest = await GuestProfile.findOne({ _id: guestId, businessId }).lean();
    
    if (!guest) {
      return res.status(404).json({ error: "Guest profile not found" });
    }

    res.json(guest);
  } catch (error) {
    console.error("[getGuestById] Error:", error);
    res.status(500).json({ error: "Server error" });
  }
}
