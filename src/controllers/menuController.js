import MenuItem from "../models/menuItem.js"

/** Accept businessId with fallback to legacy restaurantId */
function resolveBusinessId(req) {
    return (
        req.session?.user?.businessId ||
        req.query.businessId ||
        req.query.restaurantId ||
        req.body?.businessId ||
        req.body?.restaurantId
    )
}

// GET /menu-items?businessId=...
export async function getMenuItems(req, res) {
    try {
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "Missing businessId parameter" })
        }

        const items = await MenuItem.find({ businessId }).sort({ createdAt: -1 })

        return res.json(items)
    } catch (err) {
        console.error("[getMenuItems]", err)
        return res.status(500).json({ error: "Failed to fetch menu items" })
    }
}

// POST /menu-items
export async function createMenuItem(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { name, price, category, type, description, imageUrl, isAvailable } = req.body

        if (!businessId || !name || price === undefined || !category || !type) {
            return res.status(400).json({ error: "Missing required fields (businessId, name, price, category, type)" })
        }

        const newItem = new MenuItem({
            businessId,
            name,
            price,
            category,
            type,
            description,
            imageUrl,
            isAvailable: isAvailable !== undefined ? isAvailable : true
        })

        await newItem.save()

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

        // Validate that the request provides correct tracking reference
        const item = await MenuItem.findOneAndUpdate(
            { _id: id, businessId },
            { $set: req.body },
            { new: true, runValidators: true }
        )

        if (!item) {
            return res.status(404).json({ error: "Menu item not found or unauthorized" })
        }

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

        return res.json(item)
    } catch (err) {
        console.error("[toggleMenuItemAvailability]", err)
        return res.status(500).json({ error: "Failed to toggle availability" })
    }
}
