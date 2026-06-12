import express from "express"
import { waiterOrders, createWaiterOrder } from "../controllers/waiterOrdersController.js"
import { updateOrderStatus } from "../controllers/kitchenController.js"
import { markPaid } from "../controllers/orderController.js"
import {
    createWaiterCall,
    listWaiterCalls,
    claimWaiterCall,
    resolveWaiterCall,
} from "../controllers/waiterCallController.js"

import { listServicePoints } from "../controllers/servicePointController.js"

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
router.post("/orders", createWaiterOrder)
router.patch("/orders/:orderId/status", updateOrderStatus)
router.patch("/orders/:orderId/mark-paid", markPaid)

// Service Points
router.get("/service-points", listServicePoints)

// Calls actions
router.patch("/calls/:id/claim", claimWaiterCall)
router.patch("/calls/:id/resolve", resolveWaiterCall)

export default router
