import MenuItem from "../models/menuItem.js";
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js";
import { enrichMenuItemsWithInventory } from "../services/simpleStockMenuService.js";
import { DISCOVERY_VISIBLE_BUSINESS_STATUSES, isDiscoveryBusinessVisible } from "../services/discoveryPublicationService.js";
import { PublicBusinessResolutionError, resolvePublicBusiness } from "../services/publicBusinessResolverService.js";

const publicImage = (value) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

export async function getDiscoveryMenu(req, res) {
  try {
    const { business } = await resolvePublicBusiness({
      countryCode: req.params.countryCode,
      businessSlug: req.params.slug,
      statuses: DISCOVERY_VISIBLE_BUSINESS_STATUSES,
    });
    if (!business || !isDiscoveryBusinessVisible(business) ||
        !["restaurant", "bar_lounge"].includes(business.businessType) ||
        !resolveBusinessCapabilities(business).visibleModules.includes("foodService")) {
      return res.status(404).json({ error: "Menu not found" });
    }

    const menuItems = await MenuItem.find({
      businessId: business.businessId,
      archivedAt: null,
    }).sort({ createdAt: -1 });
    const enriched = await enrichMenuItemsWithInventory({
      businessId: business.businessId,
      menuItems,
    });
    const items = enriched.filter((item) => item.isAvailable === true).map((item) => ({
      id: String(item._id),
      name: item.name,
      description: item.description || null,
      price: item.price,
      category: item.category,
      type: item.type,
      imageUrl: publicImage(item.imageUrl),
      prepTimeMinutes: item.prepTimeMinutes ?? null,
    }));
    res.set("Cache-Control", "private, no-store, max-age=0");
    return res.json({
      currency: business.currency,
      categories: [...new Set(items.map((item) => item.category))],
      items,
    });
  } catch (error) {
    if (error instanceof PublicBusinessResolutionError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[discovery:menu]", error);
    return res.status(500).json({ error: "Unable to load menu" });
  }
}
