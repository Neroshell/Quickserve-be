import express from "express"
import { waiterOrders } from "../controllers/waiterOrdersController.js"
import { updateOrderStatus } from "../controllers/kitchenController.js"
import {
    createWaiterCall,
    listWaiterCalls,
    claimWaiterCall,
    resolveWaiterCall,
} from "../controllers/waiterCallController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

// ==========================================
// OPEN ROUTES (used by table/customer devices)
// ==========================================

// Calls access
router.get("/calls", listWaiterCalls)   // Polled by customer table app
router.post("/calls", createWaiterCall) // Created by customer table app


// ==========================================
// PROTECTED ROUTES (waiter role required)
// ==========================================
router.use(requireAuth, requireRole("waiter"))

// Orders
router.get("/", waiterOrders)
router.patch("/orders/:orderId/status", updateOrderStatus)

// Calls actions
router.patch("/calls/:id/claim", claimWaiterCall)
router.patch("/calls/:id/resolve", resolveWaiterCall)

export default router
