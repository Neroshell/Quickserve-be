import express from "express"
import { ownerOrders, ownerAnalytics } from "../controllers/ownerController.js"

const router = express.Router()

// GET /owner/orders
router.get("/orders", ownerOrders)

// GET /owner/analytics
router.get("/analytics", ownerAnalytics)

export default router
