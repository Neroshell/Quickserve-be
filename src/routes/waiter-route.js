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
router.use(requireAuth, requireRole("waiter"))

// Orders: GET /waiter?status=ready|placed|in_progress|all
router.get("/", waiterOrders)

// Mark order as served (completed) — waiter action, not a kitchen action
// PATCH /waiter/orders/:orderId/status
router.patch("/orders/:orderId/status", updateOrderStatus)

// router.get("/ready", waiterReadyOrders)

// Calls
router.get("/calls", listWaiterCalls) // /waiter/calls?status=active|pending|acknowledged|resolved
router.post("/calls", createWaiterCall) // customer/table hits this
router.patch("/calls/:id/claim", claimWaiterCall) // waiter
router.patch("/calls/:id/resolve", resolveWaiterCall) // waiter

export default router
