import express from "express"
import { waiterOrders, waiterReadyOrders } from "../controllers/waiterController.js"

const router = express.Router()

// ✅ supports tabs: /waiter?status=placed | in_progress | ready | completed | all
router.get("/", waiterOrders)

// optional legacy endpoint
router.get("/ready", waiterReadyOrders)

export default router
