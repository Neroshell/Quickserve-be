import express from "express"
import { ownerOrders, ownerAnalytics, getTableSessionsOverview } from "../controllers/ownerController.js"

const router = express.Router()

// GET /owner/orders
router.get("/orders", ownerOrders)

// GET /owner/analytics
router.get("/analytics", ownerAnalytics)

// GET /owner/table-sessions/overview
router.get("/table-sessions/overview", getTableSessionsOverview)

export default router
