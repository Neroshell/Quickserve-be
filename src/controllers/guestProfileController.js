import GuestProfile from "../models/GuestProfile.js";
import Business from "../models/Business.js";
import { DateTime } from "luxon";

/**
 * Get paginated guest profiles for the authenticated owner's business
 */
export async function getGuests(req, res) {
  try {
    const businessId = req.session?.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      page = "1",
      limit = "50",
      search = "",
      marketingConsent,
      sortBy = "lastVisitAt",
      sortOrder = "desc",
      filterBy = "all", // all, consent_only, no_consent, top_spenders, most_orders, highest_visits, recent, inactive
      dateRange = "all", // all, today, yesterday, last7, thisMonth, custom
      startDate,
      endDate
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    
    // Construct query
    const query = { businessId };

    // Fetch business for timezone
    const business = await Business.findOne({ $or: [{ businessId }, { restaurantId: businessId }] }).lean();
    const timezone = business?.timezone || "UTC";

    // Search by email or name
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
      ];
    }

    // Filters
    if (filterBy === "leads") {
      query.guestStatus = "lead";
    } else {
      // By default (and for all analytical filters), we only want actual customers
      query.guestStatus = "customer";
      
      if (filterBy === "consent_only") {
        query.marketingConsent = true;
      } else if (filterBy === "no_consent") {
        query.marketingConsent = false;
      } else if (filterBy === "top_spenders" || filterBy === "most_orders" || filterBy === "highest_visits") {
        // No strict threshold, just handled by forcing a sort down below
      } else if (filterBy === "recent") {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query.lastVisitAt = { $gte: thirtyDaysAgo };
      } else if (filterBy === "inactive") {
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        query.lastVisitAt = { $lt: ninetyDaysAgo };
      }
    }

    // Date Range Filtering
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
          startBound = now.minus({ days: 6 }).startOf("day"); // 6 days ago + today = 7 days
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
        const dateField = query.guestStatus === "lead" ? "lastCapturedAt" : "lastVisitAt";
        query[dateField] = query[dateField] || {};
        if (startBound) query[dateField].$gte = startBound.toJSDate();
        if (endBound) query[dateField].$lte = endBound.toJSDate();
      }
    }

    // Explicit marketingConsent override from query param
    if (marketingConsent === "true") {
      query.marketingConsent = true;
    } else if (marketingConsent === "false") {
      query.marketingConsent = false;
    }

    const sortParams = {};
    const validSortFields = ["lastVisitAt", "totalSpendCents", "totalSpend", "visitCount", "orderCount", "createdAt", "averageSpendCents"];
    
    // Support the requested `sort` parameter if provided
    const requestedSort = req.query.sort || sortBy;
    let finalSortField = validSortFields.includes(requestedSort) ? requestedSort : "lastVisitAt";

    // Map frontend friendly names to DB fields
    if (finalSortField === "totalSpend") finalSortField = "totalSpendCents";

    if (filterBy === "top_spenders") {
      sortParams.totalSpendCents = -1;
    } else if (filterBy === "most_orders") {
      sortParams.orderCount = -1;
      sortParams.totalSpendCents = -1;
    } else if (filterBy === "highest_visits") {
      sortParams.visitCount = -1;
      sortParams.totalSpendCents = -1;
    } else {
      sortParams[finalSortField] = sortOrder === "asc" ? 1 : -1;
    }

    const guests = await GuestProfile.find(query)
      .sort(sortParams)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const totalCount = await GuestProfile.countDocuments(query);
    const hasMore = (pageNum * limitNum) < totalCount;

    res.json({
      guests,
      pagination: {
        hasMore,
        page: pageNum,
        limit: limitNum,
        total: totalCount
      }
    });
  } catch (error) {
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
