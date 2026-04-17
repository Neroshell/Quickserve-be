import express from "express"
import {
    getMenuItems,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    toggleMenuItemAvailability
} from "../controllers/menuController.js"

const router = express.Router()

// GET /menu-items?businessId=...
router.get("/", getMenuItems)

// POST /menu-items
router.post("/", createMenuItem)

// PATCH /menu-items/:id
router.patch("/:id", updateMenuItem)

// DELETE /menu-items/:id
router.delete("/:id", deleteMenuItem)

// PATCH /menu-items/:id/availability
router.patch("/:id/availability", toggleMenuItemAvailability)

export default router
