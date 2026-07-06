import GuestProfile from "../models/GuestProfile.js"
import GuestVisit from "../models/GuestVisit.js"
import Business from "../models/Business.js"
import Order from "../models/order.js"

/**
 * Upsert a guest profile and tracking visits based on an order and receipt email.
 * Defensive coding ensures missing fields don't crash the flow.
 */
export async function upsertGuestProfileFromOrder({ businessId, order, email, marketingConsent, trackVisit = true }) {
  if (!businessId || !email || !order) return null;

  const normalizedEmail = email.toLowerCase().trim();
  const orderId = order.orderId || order._id?.toString();

  if (!orderId) {
    console.warn("[upsertGuestProfileFromOrder] Missing orderId on order object.");
    return null;
  }

  try {
    // Fetch business to determine timezone
    const business = await Business.findOne({ $or: [{ businessId }, { restaurantId: businessId }] }).lean();
    const timezone = business?.timezone || "UTC";

    const orderDate = order.createdAt ? new Date(order.createdAt) : new Date();
    
    // Calculate local date (YYYY-MM-DD)
    const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const localDateStr = localDateFormatter.format(orderDate);

    // Get or Create Guest Profile
    let profile = await GuestProfile.findOne({ businessId, email: normalizedEmail });
    if (!profile) {
      profile = new GuestProfile({
        businessId,
        email: normalizedEmail,
        guestStatus: "lead",
        firstCapturedAt: new Date(),
        lastCapturedAt: new Date(),
        source: "receipt",
        visitCount: 0,
        orderCount: 0,
        paidOrderCount: 0,
        totalSpendCents: 0,
        averageSpendCents: 0,
        averageOrderSpendCents: 0,
        favouriteItems: [],
        processedOrderIds: [],
        processedPaidOrderIds: [],
        marketingConsent: false,
      });
    } else {
      // Profile exists, update lastCapturedAt
      profile.lastCapturedAt = new Date();
    }

    // Handle Marketing Consent
    if (marketingConsent === true && !profile.marketingConsent) {
      profile.marketingConsent = true;
      profile.marketingConsentUpdatedAt = new Date();
    }

    // --- CRM Ownership Lock Logic ---
    if (trackVisit && order.paymentStatus === "paid" && !order.crmProcessed) {
      // Lock the CRM ownership to this email for the first time
      order.crmEmail = normalizedEmail;
      order.crmProcessed = true;
      order.crmProcessedAt = new Date();
      
      await Order.updateOne({ businessId, orderId }, {
        $set: {
          crmEmail: normalizedEmail,
          crmProcessed: true,
          crmProcessedAt: new Date()
        }
      });
    }

    // Determine if this profile is allowed to track the spend
    // It is allowed if the email matches the locked crmEmail, OR if it's currently unlocked (though we just locked it above).
    const isCrmOwner = (order.crmEmail === normalizedEmail) || (!order.crmProcessed);
    const canTrackSpend = trackVisit && order.paymentStatus === "paid" && isCrmOwner;


    // Only track visits and orders when explicitly requested (markPaid / webhook) AND if allowed by CRM Ownership
    let visit = null;
    if (canTrackSpend) {
      // Get or Create Guest Visit
      visit = await GuestVisit.findOne({ businessId, email: normalizedEmail, visitDate: localDateStr });
      let isNewVisit = false;
      if (!visit) {
        isNewVisit = true;
        visit = new GuestVisit({
          businessId,
          email: normalizedEmail,
          visitDate: localDateStr,
          orderIds: [],
          paidOrderIds: [],
          spendCents: 0,
        });
      }

      // Process Visit
      if (isNewVisit) {
        profile.visitCount += 1;
        
        if (!profile.firstVisitAt) {
          profile.firstVisitAt = orderDate;
          profile.firstOrderId = orderId;
        }
      }

      // Update Last Visit Date
      if (!profile.lastVisitAt || orderDate > profile.lastVisitAt) {
        profile.lastVisitAt = orderDate;
        profile.lastOrderId = orderId;
      }

      // Process Order (for order count)
      if (!profile.processedOrderIds.includes(orderId)) {
        profile.orderCount += 1;
        profile.processedOrderIds.push(orderId);
        
        if (!visit.orderIds.includes(orderId)) {
          visit.orderIds.push(orderId);
        }

        // Maintain array size
        if (profile.processedOrderIds.length > 200) {
          profile.processedOrderIds = profile.processedOrderIds.slice(-200);
        }
      }
    }

    if (canTrackSpend) {
      // Process Paid Order (for spend and favourite items)
      if (!profile.processedPaidOrderIds.includes(orderId)) {
        
        // Promote to customer
        profile.guestStatus = "customer";
        
        let orderTotalCents = 0;
        if (order.total && !isNaN(order.total)) {
          orderTotalCents = Math.round((Number(order.total) - Number(order.tipAmount || 0)) * 100);
        } else if (order.totalInCents && !isNaN(order.totalInCents)) {
          orderTotalCents = Number(order.totalInCents);
        }

        profile.totalSpendCents += orderTotalCents;
        visit.spendCents += orderTotalCents;
        profile.paidOrderCount = (profile.paidOrderCount || 0) + 1;
        
        profile.processedPaidOrderIds.push(orderId);
        if (!visit.paidOrderIds.includes(orderId)) {
          visit.paidOrderIds.push(orderId);
        }

        // Maintain array size
        if (profile.processedPaidOrderIds.length > 200) {
          profile.processedPaidOrderIds = profile.processedPaidOrderIds.slice(-200);
        }

        // Process Items for Favourite Items
        if (order.items && Array.isArray(order.items)) {
          const itemsMap = new Map();
          
          // Populate map with existing
          profile.favouriteItems.forEach((item) => {
            itemsMap.set(item.itemName, item.quantity);
          });

          // Add new items
          order.items.forEach((item) => {
            if (item.itemName && item.quantity && !isNaN(item.quantity)) {
              const currentQty = itemsMap.get(item.itemName) || 0;
              itemsMap.set(item.itemName, currentQty + Number(item.quantity));
            }
          });

          // Sort and take top 10
          const sortedItems = Array.from(itemsMap.entries())
            .map(([itemName, quantity]) => ({ itemName, quantity }))
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, 10);

          profile.favouriteItems = sortedItems;
        }
      }

      // Recalculate Averages
      if (profile.visitCount > 0) {
        profile.averageSpendCents = Math.round(profile.totalSpendCents / profile.visitCount);
      }
      
      // Average Spend per Order: Should be totalSpend / number of PAID orders
      if (profile.paidOrderCount > 0) {
        profile.averageOrderSpendCents = Math.round(profile.totalSpendCents / profile.paidOrderCount);
      }

      const saves = [profile.save()];
      if (visit) saves.push(visit.save());
      
      await Promise.all(saves);
    } else {
      // canTrackSpend is false — only save the profile (for consent / email capture as Lead)
      await profile.save();
    }

    return profile;
  } catch (error) {
    console.error("[upsertGuestProfileFromOrder] Failed to upsert profile:", error);
    return null; // Return null on error, don't throw to avoid crashing flow
  }
}
