import express from "express"
import { getSettings, updateSettings, updateOperatingHours, updateOrderingPreferences, updatePaymentPreferences, updateTablePreferences, getCategories, addCategory, removeCategory } from "../controllers/businessController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

const requireManager = [requireAuth, requireRole("owner", "admin", "manager")]

// GET /restaurant/settings
router.get("/settings", getSettings)

// PATCH /restaurant/settings
router.patch("/settings", requireManager, updateSettings)

// PATCH /restaurant/operating-hours
router.patch("/operating-hours", requireManager, updateOperatingHours)

// PATCH /restaurant/settings/ordering-preferences
router.patch("/settings/ordering-preferences", requireManager, updateOrderingPreferences)

// PATCH /restaurant/settings/payment-preferences
router.patch("/settings/payment-preferences", requireManager, updatePaymentPreferences)

// PATCH /restaurant/settings/table-preferences
router.patch("/settings/table-preferences", requireManager, updateTablePreferences)

// GET /restaurant/categories
router.get("/categories", getCategories)

// POST /restaurant/categories
router.post("/categories", requireManager, addCategory)

// DELETE /restaurant/categories
router.delete("/categories", requireManager, removeCategory)

export default router
