import MenuItem from "../models/menuItem.js"

// GET /menu-items?restaurantId=...
export async function getMenuItems(req, res) {
    try {
        const { restaurantId } = req.query

        if (!restaurantId) {
            return res.status(400).json({ error: "Missing restaurantId parameter" })
        }

        const items = await MenuItem.find({ restaurantId }).sort({ createdAt: -1 })

        return res.json(items)
    } catch (err) {
        console.error("[getMenuItems]", err)
        return res.status(500).json({ error: "Failed to fetch menu items" })
    }
}

// POST /menu-items
export async function createMenuItem(req, res) {
    try {
        const { restaurantId, name, price, category, type, description, imageUrl, isAvailable } = req.body

        if (!restaurantId || !name || price === undefined || !category || !type) {
            return res.status(400).json({ error: "Missing required fields (restaurantId, name, price, category, type)" })
        }

        const newItem = new MenuItem({
            restaurantId,
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
        const { restaurantId } = req.body

        if (!restaurantId) {
            return res.status(400).json({ error: "Missing restaurantId" })
        }

        // Validate that the request provides correct tracking reference
        const item = await MenuItem.findOneAndUpdate(
            { _id: id, restaurantId },
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
        const { restaurantId } = req.query // Usually passed in query or body

        if (!restaurantId) {
            return res.status(400).json({ error: "Missing restaurantId" })
        }

        const deletedItem = await MenuItem.findOneAndDelete({ _id: id, restaurantId })

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
        const { restaurantId, isAvailable } = req.body

        if (!restaurantId || isAvailable === undefined) {
            return res.status(400).json({ error: "Missing restaurantId or isAvailable flag" })
        }

        const item = await MenuItem.findOneAndUpdate(
            { _id: id, restaurantId },
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
