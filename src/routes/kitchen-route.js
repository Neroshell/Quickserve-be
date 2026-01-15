import express from "express"
import { kitchenOrders, updateOrderStatus } from "../controllers/kitchenController.js" 

const router = express.Router()

// GET /kitchen
router.get("/", kitchenOrders)

// PATCH /kitchen/orders/:orderId/status
router.patch("/orders/:orderId/status", updateOrderStatus)

export default router
