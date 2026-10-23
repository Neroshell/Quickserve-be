import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import {
    CACHE_TTL_SECONDS,
    cacheKeys,
    responseCache,
} from "../services/responseCacheService.js"
import { invalidateMenuMutation } from "../services/cacheInvalidationService.js"
import {
    archiveMappedMenuItem,
    enrichMenuItemsWithInventory,
    hasAnyMenuInventoryMapping,
    setMappedMenuManualAvailability,
} from "../services/simpleStockMenuService.js"
import { normalizeMenuFulfillmentConfiguration } from "../services/orderFulfillmentService.js"
import { MENU_ITEM_PRICE_ERROR, parseMenuItemPrice } from "../utils/menuItemPrice.js"

/** Accept businessId with fallback to legacy businessId */
function resolveBusinessId(req) {
    return (
        req.session?.user?.businessId ||
        req.query.businessId ||
        req.query.businessId ||
        req.body?.businessId ||
        req.body?.businessId
    )
}

function handleMenuError(res, err, fallback) {
    if (Number.isInteger(err?.statusCode)) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code })
    }
    return res.status(500).json({ error: fallback })
}

// Guest menu responses intentionally expose the sellability result, but not
// inventory balances, reservation quantities, or mapping details. Owners and
// authenticated staff retain the richer operational DTO used by their menu
// workspace through the owner cache variant below.
function toPublicMenuItemDTO(item) {
    const source = item || {}
    const id = source.id || source._id
    const availableQuantity = source.inventory?.availableQuantity ?? source.stockQuantity
    const availabilityStatus = source.isAvailable === true
        ? "available"
        : source.manualIsAvailable !== false && availableQuantity === 0
            ? "sold_out"
            : "unavailable"
    const payload = {
        ...(id ? { id: String(id), _id: source._id || id } : {}),
        businessId: source.businessId,
        name: source.name,
        description: source.description || "",
        imageUrl: source.imageUrl || "",
        fulfillmentStation: source.fulfillmentStation ?? null,
        fulfillmentBehavior: source.fulfillmentBehavior ?? null,
        isAvailable: source.isAvailable === true,
        availabilityStatus,
    }
    if (source.price !== undefined) payload.price = source.price
    if (source.prepTimeMinutes !== undefined) payload.prepTimeMinutes = source.prepTimeMinutes
    if (source.category !== undefined) payload.category = source.category
    if (source.type !== undefined) payload.type = source.type
    if (Number.isFinite(source.orderCount)) payload.orderCount = source.orderCount
    return payload
}

// GET /menu-items?businessId=...
export async function getMenuItems(req, res) {
    try {
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "Missing businessId parameter" })
        }

        const isOwningStaff =
            req.session?.user?.businessId === businessId
        const cacheKey = cacheKeys.menuItems(businessId, { owner: isOwningStaff })
        const cached = await responseCache.get(cacheKey)
        if (cached.hit && Array.isArray(cached.value)) {
            return res.json(cached.value)
        }

        const filter = { businessId, archivedAt: null }

        const items = await MenuItem.find(filter).sort({ createdAt: -1 })
        const enriched = await enrichMenuItemsWithInventory({ businessId, menuItems: items })
        // Visibility is a guest-interface preference. The API must return the
        // canonical availability state for every non-archived item so guests
        // can either hide unavailable items or display them as unavailable.
        const payload = isOwningStaff
            ? enriched
            : enriched.map(toPublicMenuItemDTO)

        await responseCache.set(
            cacheKey,
            payload,
            CACHE_TTL_SECONDS.TENANT_STABLE,
        )

        return res.json(payload)
    } catch (err) {
        console.error("[getMenuItems]", err)
        return handleMenuError(res, err, "Failed to fetch menu items")
    }
}

// POST /menu-items
export async function createMenuItem(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const {
            name, price, prepTimeMinutes, category, type, description, imageUrl,
            isAvailable, trackStock, stockQuantity, lowStockThreshold,
            fulfillmentStation, fulfillmentBehavior,
        } = req.body

        if (trackStock === true) {
            return res.status(409).json({
                error: "Tracked menu items must be created through Simple Stock.",
                code: "SIMPLE_STOCK_CREATE_REQUIRED",
            })
        }

        if (!businessId || !name || !category || !type) {
            return res.status(400).json({ error: "Missing required fields (businessId, name, category, type)" })
        }
        const normalizedPrice = parseMenuItemPrice(price)
        if (normalizedPrice === null) {
            return res.status(400).json({ error: MENU_ITEM_PRICE_ERROR })
        }
        const fulfillment = normalizeMenuFulfillmentConfiguration({
            type,
            fulfillmentStation,
            fulfillmentBehavior,
            prepTimeMinutes,
        })

        // Validate description word count
        if (description) {
            const wordCount = description.trim().split(/\s+/).filter(Boolean).length
            if (wordCount > 100) {
                return res.status(400).json({ error: "Description must be 100 words or less." })
            }
        }

        const newItem = new MenuItem({
            businessId,
            name,
            price: normalizedPrice,
            prepTimeMinutes: fulfillment.prepTimeMinutes,
            category,
            type: fulfillment.type,
            fulfillmentStation: fulfillment.fulfillmentStation,
            fulfillmentBehavior: fulfillment.fulfillmentBehavior,
            description,
            imageUrl,
            isAvailable: isAvailable !== undefined ? isAvailable : true,
            trackStock: trackStock !== undefined ? trackStock : false,
            stockQuantity: stockQuantity !== undefined ? stockQuantity : null,
            lowStockThreshold: lowStockThreshold !== undefined ? lowStockThreshold : 5
        })

        await newItem.save()

        await invalidateMenuMutation(businessId)

        return res.status(201).json(newItem)
    } catch (err) {
        console.error("[createMenuItem]", err)
        return handleMenuError(res, err, "Failed to create menu item")
    }
}

// PATCH /menu-items/:id
export async function updateMenuItem(req, res) {
    try {
        const { id } = req.params
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "Missing businessId" })
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "price")) {
            const normalizedPrice = parseMenuItemPrice(req.body.price)
            if (normalizedPrice === null) {
                return res.status(400).json({ error: MENU_ITEM_PRICE_ERROR })
            }
            req.body.price = normalizedPrice
        }

        const existingItem = await MenuItem.findOne({ _id: id, businessId, archivedAt: null }).lean()
        if (!existingItem) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        const mapped = await hasAnyMenuInventoryMapping({ businessId, menuItemId: id })
        const protectedStockFields = [
            "trackStock",
            "stockQuantity",
            "lowStockThreshold",
            "isAvailable",
            "manualIsAvailable",
        ]
        if (mapped && protectedStockFields.some((field) => req.body[field] !== undefined)) {
            return res.status(409).json({
                error: "Mapped stock and availability must be changed through inventory controls.",
                code: "DIRECT_MAPPED_STOCK_MUTATION_FORBIDDEN",
            })
        }

        // Validate description word count if provided
        if (req.body.description) {
            const wordCount = req.body.description.trim().split(/\s+/).filter(Boolean).length
            if (wordCount > 100) {
                return res.status(400).json({ error: "Description must be 100 words or less." })
            }
        }

        if (
            req.body.prepTimeMinutes !== undefined ||
            req.body.type !== undefined ||
            req.body.fulfillmentStation !== undefined ||
            req.body.fulfillmentBehavior !== undefined
        ) {
            const fulfillment = normalizeMenuFulfillmentConfiguration({
                type: req.body.type ?? existingItem.type,
                fulfillmentStation: req.body.fulfillmentStation ?? existingItem.fulfillmentStation,
                fulfillmentBehavior: req.body.fulfillmentBehavior ?? existingItem.fulfillmentBehavior,
                prepTimeMinutes: req.body.prepTimeMinutes ?? existingItem.prepTimeMinutes,
            })
            req.body.type = fulfillment.type
            req.body.fulfillmentStation = fulfillment.fulfillmentStation
            req.body.fulfillmentBehavior = fulfillment.fulfillmentBehavior
            req.body.prepTimeMinutes = fulfillment.prepTimeMinutes
        }

        // Whitelist updatable fields — never $set raw req.body (prevents moving the
        // item to another businessId or writing arbitrary fields).
        const ALLOWED_FIELDS = ["name", "price", "prepTimeMinutes", "category", "type", "fulfillmentStation", "fulfillmentBehavior", "description", "imageUrl", "imagePublicId", "isAvailable", "trackStock", "stockQuantity", "lowStockThreshold"]
        const updates = {}
        for (const field of ALLOWED_FIELDS) {
            if (req.body[field] !== undefined) updates[field] = req.body[field]
        }

        const item = await MenuItem.findOneAndUpdate(
            { _id: id, businessId, archivedAt: null },
            { $set: updates },
            { new: true, runValidators: true }
        )

        if (!item) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        await invalidateMenuMutation(businessId)

        return res.json(item)
    } catch (err) {
        console.error("[updateMenuItem]", err)
        return handleMenuError(res, err, "Failed to update menu item")
    }
}

// DELETE /menu-items/:id
export async function deleteMenuItem(req, res) {
    try {
        const { id } = req.params
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "Missing businessId" })
        }

        if (await hasAnyMenuInventoryMapping({ businessId, menuItemId: id })) {
            await archiveMappedMenuItem({ businessId, menuItemId: id })
            return res.json({ message: "Menu item archived successfully", archived: true })
        }

        const deletedItem = await MenuItem.findOneAndDelete({ _id: id, businessId, archivedAt: null })

        if (!deletedItem) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        await invalidateMenuMutation(businessId)

        return res.json({ message: "Menu item deleted successfully" })
    } catch (err) {
        console.error("[deleteMenuItem]", err)
        return handleMenuError(res, err, "Failed to delete menu item")
    }
}

// PATCH /menu-items/:id/availability
export async function toggleMenuItemAvailability(req, res) {
    try {
        const { id } = req.params
        const businessId = resolveBusinessId(req)
        const { isAvailable } = req.body

        if (!businessId || isAvailable === undefined) {
            return res.status(400).json({ error: "Missing businessId or isAvailable flag" })
        }

        let item
        if (await hasAnyMenuInventoryMapping({ businessId, menuItemId: id })) {
            item = await setMappedMenuManualAvailability({
                businessId,
                menuItemId: id,
                isAvailable,
            })
        } else {
            item = await MenuItem.findOneAndUpdate(
                { _id: id, businessId, archivedAt: null },
                { $set: { isAvailable } },
                { new: true }
            )
        }

        if (!item) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        await invalidateMenuMutation(businessId)

        return res.json(item)
    } catch (err) {
        console.error("[toggleMenuItemAvailability]", err)
        return handleMenuError(res, err, "Failed to toggle availability")
    }
}

/**
 * GET /menu-items/popular?businessId=...
 * Returns up to 8 menu items ranked by total quantity ordered in the last 7 days.
 * Falls back to an empty array if there are no recent orders.
 */
export async function getPopularItems(req, res) {
    try {
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "Missing businessId parameter" })
        }

        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

        // Aggregate: unwind order items, group by itemName, sum quantities
        const aggregated = await Order.aggregate([
            {
                $match: {
                    businessId,
                    createdAt: { $gte: since },
                    status: { $in: ["placed", "in_progress", "ready", "completed"] }
                }
            },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.itemName",
                    totalOrdered: { $sum: "$items.quantity" }
                }
            },
            { $sort: { totalOrdered: -1 } },
            { $limit: 8 }
        ])

        if (aggregated.length === 0) {
            return res.json([])
        }

        // Map popular names to rank for sorting
        const rankMap = {}
        aggregated.forEach((a, i) => { rankMap[a._id] = i })

        // Fetch matching MenuItem docs by name
        const popularNames = aggregated.map(a => a._id)
        const items = await MenuItem.find({
            businessId,
            name: { $in: popularNames },
            archivedAt: null,
        })

        // Sort by popularity rank, inject orderCount for frontend use
        const enrichedItems = await enrichMenuItemsWithInventory({ businessId, menuItems: items })
        const sorted = enrichedItems
            .map(item => ({
                ...item,
                orderCount: aggregated.find(a => a._id === item.name)?.totalOrdered ?? 0
            }))
            .sort((a, b) => (rankMap[a.name] ?? 99) - (rankMap[b.name] ?? 99))

        const isOwningStaff = req.session?.user?.businessId === businessId
        return res.json(isOwningStaff ? sorted : sorted.map(toPublicMenuItemDTO))
    } catch (err) {
        console.error("[getPopularItems]", err)
        return handleMenuError(res, err, "Failed to fetch popular items")
    }
}

