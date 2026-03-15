import express from "express"
import { getSettings, updateSettings, updateOperatingHours } from "../controllers/restaurantController.js"

const router = express.Router()

// GET /restaurant/settings
router.get("/settings", getSettings)

// PATCH /restaurant/settings
router.patch("/settings", updateSettings)

// PATCH /restaurant/operating-hours
router.patch("/operating-hours", updateOperatingHours)

export default router
