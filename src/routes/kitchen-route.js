import express from "express"
import { kitchenOrders, updateOrderStatus } from "../controllers/kitchenController.js" 

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()
router.use(requireAuth, requireRole("kitchen"))

/**
 * @openapi
 * /kitchen/:
 *   get:
 *     summary: Retrieve active food orders for the kitchen view (Kitchen only)
 *     tags:
 *       - Kitchen
 *     responses:
 *       200:
 *         description: List of kitchen orders
 */
router.get("/", kitchenOrders)

/**
 * @openapi
 * /kitchen/orders/{orderId}/status:
 *   patch:
 *     summary: Update order status from kitchen (Kitchen only)
 *     tags:
 *       - Kitchen
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [placed, in_progress, ready, completed]
 *     responses:
 *       200:
 *         description: Order status updated successfully
 */
router.patch("/orders/:orderId/status", updateOrderStatus)

export default router
