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
 * /kitchen/orders/{orderId}/fulfillment:
 *   patch:
 *     summary: Advance kitchen order-line fulfilment (Kitchen only)
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
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [start, ready]
 *     responses:
 *       200:
 *         description: Order status updated successfully
 */
router.patch("/orders/:orderId/fulfillment", updateOrderStatus)

export default router
