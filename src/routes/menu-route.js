import express from "express"
import {
    getMenuItems,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    toggleMenuItemAvailability
} from "../controllers/menuController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

const requireManager = [requireAuth, requireRole("owner", "admin", "manager")]

// GET /menu-items?businessId=...
router.get("/", getMenuItems)

// POST /menu-items
router.post("/", requireManager, createMenuItem)

// PATCH /menu-items/:id
router.patch("/:id", requireManager, updateMenuItem)

// DELETE /menu-items/:id
router.delete("/:id", requireManager, deleteMenuItem)

// PATCH /menu-items/:id/availability
router.patch("/:id/availability", requireManager, toggleMenuItemAvailability)

export default router
