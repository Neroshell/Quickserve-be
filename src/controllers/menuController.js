import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import {
    CACHE_TTL_SECONDS,
    cacheKeys,
    responseCache,
} from "../services/responseCacheService.js"
import { invalidateMenuMutation } from "../services/cacheInvalidationService.js"

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

function normalizePrepTimeMinutes(value) {
    const minutes = Number(value)
    if (!Number.isInteger(minutes) || minutes < 1) return null
    return minutes
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

        const filter = { businessId }
        if (!isOwningStaff) filter.isAvailable = true

        const items = await MenuItem.find(filter).sort({ createdAt: -1 })

        const payload = items.map(item =>
            typeof item?.toJSON === "function" ? item.toJSON() : item
        )

        await responseCache.set(
            cacheKey,
            payload,
            CACHE_TTL_SECONDS.TENANT_STABLE,
        )

        return res.json(payload)
    } catch (err) {
        console.error("[getMenuItems]", err)
        return res.status(500).json({ error: "Failed to fetch menu items" })
    }
}

// POST /menu-items
export async function createMenuItem(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { name, price, prepTimeMinutes, category, type, description, imageUrl, isAvailable, trackStock, stockQuantity, lowStockThreshold } = req.body

        if (!businessId || !name || price === undefined || prepTimeMinutes === undefined || !category || !type) {
            return res.status(400).json({ error: "Missing required fields (businessId, name, price, prepTimeMinutes, category, type)" })
        }

        const normalizedPrepTimeMinutes = normalizePrepTimeMinutes(prepTimeMinutes)
        if (normalizedPrepTimeMinutes === null) {
            return res.status(400).json({ error: "Preparation time must be a whole number of minutes." })
        }

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
            price,
            prepTimeMinutes: normalizedPrepTimeMinutes,
            category,
            type,
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
        return res.status(500).json({ error: "Failed to create menu item" })
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

        // Validate description word count if provided
        if (req.body.description) {
            const wordCount = req.body.description.trim().split(/\s+/).filter(Boolean).length
            if (wordCount > 100) {
                return res.status(400).json({ error: "Description must be 100 words or less." })
            }
        }

        if (req.body.prepTimeMinutes !== undefined) {
            const normalizedPrepTimeMinutes = normalizePrepTimeMinutes(req.body.prepTimeMinutes)
            if (normalizedPrepTimeMinutes === null) {
                return res.status(400).json({ error: "Preparation time must be a whole number of minutes." })
            }
            req.body.prepTimeMinutes = normalizedPrepTimeMinutes
        }

        // Whitelist updatable fields — never $set raw req.body (prevents moving the
        // item to another businessId or writing arbitrary fields).
        const ALLOWED_FIELDS = ["name", "price", "prepTimeMinutes", "category", "type", "description", "imageUrl", "imagePublicId", "isAvailable", "trackStock", "stockQuantity", "lowStockThreshold"]
        const updates = {}
        for (const field of ALLOWED_FIELDS) {
            if (req.body[field] !== undefined) updates[field] = req.body[field]
        }

        const item = await MenuItem.findOneAndUpdate(
            { _id: id, businessId },
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
        return res.status(500).json({ error: "Failed to update menu item" })
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

        const deletedItem = await MenuItem.findOneAndDelete({ _id: id, businessId })

        if (!deletedItem) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        await invalidateMenuMutation(businessId)

        return res.json({ message: "Menu item deleted successfully" })
    } catch (err) {
        console.error("[deleteMenuItem]", err)
        return res.status(500).json({ error: "Failed to delete menu item" })
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

        const item = await MenuItem.findOneAndUpdate(
            { _id: id, businessId },
            { $set: { isAvailable } },
            { new: true }
        )

        if (!item) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

        await invalidateMenuMutation(businessId)

        return res.json(item)
    } catch (err) {
        console.error("[toggleMenuItemAvailability]", err)
        return res.status(500).json({ error: "Failed to toggle availability" })
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
            name: { $in: popularNames }
        })

        // Sort by popularity rank, inject orderCount for frontend use
        const sorted = items
            .map(item => ({
                ...item.toObject(),
                orderCount: aggregated.find(a => a._id === item.name)?.totalOrdered ?? 0
            }))
            .sort((a, b) => (rankMap[a.name] ?? 99) - (rankMap[b.name] ?? 99))

        return res.json(sorted)
    } catch (err) {
        console.error("[getPopularItems]", err)
        return res.status(500).json({ error: "Failed to fetch popular items" })
    }
}

