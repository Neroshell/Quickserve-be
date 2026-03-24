import express from "express"
import { ownerOrders, ownerAnalytics, getTableSessionsOverview } from "../controllers/ownerController.js"
import { getWaiters, createWaiter, deleteWaiter } from "../controllers/staffController.js"

const router = express.Router()

// GET /owner/orders
router.get("/orders", ownerOrders)

// GET /owner/analytics
router.get("/analytics", ownerAnalytics)

// GET /owner/table-sessions/overview
router.get("/table-sessions/overview", getTableSessionsOverview)

// --- Waitstaff Management ---

// GET /owner/waiters?restaurantId=...
router.get("/waiters", getWaiters)

// POST /owner/waiters?restaurantId=...
router.post("/waiters", createWaiter)

// DELETE /owner/waiters/:id?restaurantId=...
router.delete("/waiters/:id", deleteWaiter)

export default router
