import express from "express"
import { kitchenOrders, updateOrderStatus } from "../controllers/kitchenController.js" 

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()
router.use(requireAuth, requireRole("kitchen"))

// GET /kitchen
router.get("/", kitchenOrders)

// PATCH /kitchen/orders/:orderId/status
router.patch("/orders/:orderId/status", updateOrderStatus)

export default router
