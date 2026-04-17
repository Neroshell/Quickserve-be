import express from "express"
import { getSettings, updateSettings, updateOperatingHours, updateOrderingPreferences, updatePaymentPreferences, updateTablePreferences, getCategories, addCategory, removeCategory } from "../controllers/businessController.js"

const router = express.Router()

// GET /restaurant/settings
router.get("/settings", getSettings)

// PATCH /restaurant/settings
router.patch("/settings", updateSettings)

// PATCH /restaurant/operating-hours
router.patch("/operating-hours", updateOperatingHours)

// PATCH /restaurant/settings/ordering-preferences
router.patch("/settings/ordering-preferences", updateOrderingPreferences)

// PATCH /restaurant/settings/payment-preferences
router.patch("/settings/payment-preferences", updatePaymentPreferences)

// PATCH /restaurant/settings/table-preferences
router.patch("/settings/table-preferences", updateTablePreferences)

// GET /restaurant/categories
router.get("/categories", getCategories)

// POST /restaurant/categories
router.post("/categories", addCategory)

// DELETE /restaurant/categories
router.delete("/categories", removeCategory)

export default router
