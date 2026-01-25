import express from "express"
import { waiterOrders } from "../controllers/waiterOrdersController.js"
import {
    createWaiterCall,
    listWaiterCalls,
    claimWaiterCall,
    resolveWaiterCall,
} from "../controllers/waiterCallController.js"

const router = express.Router()

// Orders: GET /waiter?status=ready|placed|in_progress|all
router.get("/", waiterOrders)

// router.get("/ready", waiterReadyOrders)

// Calls
router.get("/calls", listWaiterCalls) // /waiter/calls?status=active|pending|acknowledged|resolved
router.post("/calls", createWaiterCall) // customer/table hits this
router.patch("/calls/:id/claim", claimWaiterCall) // waiter
router.patch("/calls/:id/resolve", resolveWaiterCall) // waiter

export default router
