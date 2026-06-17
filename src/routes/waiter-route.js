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
/**
 * @openapi
 * /waiter/calls:
 *   get:
 *     summary: List active waiter calls for the table/customer device (Polled)
 *     tags:
 *       - Waiter
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of active waiter calls
 */
router.get("/calls", listWaiterCalls)

/**
 * @openapi
 * /waiter/calls:
 *   post:
 *     summary: Create a new waiter assistance call from a table/customer device
 *     tags:
 *       - Waiter
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - tableId
 *               - type
 *             properties:
 *               businessId:
 *                 type: string
 *               tableId:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [waiter, bill]
 *     responses:
 *       201:
 *         description: Call created successfully
 */
router.post("/calls", createWaiterCall)


// ==========================================
// PROTECTED ROUTES (waiter role required)
// ==========================================
router.use(requireAuth, requireRole("waiter"))

/**
 * @openapi
 * /waiter/:
 *   get:
 *     summary: Get all waiter orders for the authenticated waiter's business
 *     tags:
 *       - Waiter
 *     responses:
 *       200:
 *         description: List of orders
 *       401:
 *         description: Unauthorized
 */
router.get("/", waiterOrders)

/**
 * @openapi
 * /waiter/orders:
 *   post:
 *     summary: Create an offline/waiter-assisted order on behalf of a customer
 *     tags:
 *       - Waiter
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tableId
 *               - items
 *             properties:
 *               tableId:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     itemName:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     price:
 *                       type: number
 *     responses:
 *       201:
 *         description: Order created successfully
 */
router.post("/orders", createWaiterOrder)

/**
 * @openapi
 * /waiter/orders/{orderId}/status:
 *   patch:
 *     summary: Update status of an order
 *     tags:
 *       - Waiter
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

/**
 * @openapi
 * /waiter/orders/{orderId}/mark-paid:
 *   patch:
 *     summary: Mark an order as paid (Offline POS / Cash)
 *     tags:
 *       - Waiter
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
 *               - paidVia
 *             properties:
 *               paidVia:
 *                 type: string
 *                 enum: [pos_card, cash]
 *     responses:
 *       200:
 *         description: Order marked as paid
 */
router.patch("/orders/:orderId/mark-paid", markPaid)

/**
 * @openapi
 * /waiter/service-points:
 *   get:
 *     summary: List all service points (tables/rooms) for the waiter's business
 *     tags:
 *       - Waiter
 *     responses:
 *       200:
 *         description: List of service points
 */
router.get("/service-points", listServicePoints)

/**
 * @openapi
 * /waiter/calls/{id}/claim:
 *   patch:
 *     summary: Claim an active assistance call
 *     tags:
 *       - Waiter
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Call claimed successfully
 */
router.patch("/calls/:id/claim", claimWaiterCall)

/**
 * @openapi
 * /waiter/calls/{id}/resolve:
 *   patch:
 *     summary: Resolve assistance call
 *     tags:
 *       - Waiter
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Call resolved successfully
 */
router.patch("/calls/:id/resolve", resolveWaiterCall)

export default router
