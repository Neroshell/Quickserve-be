import express from "express"
import rateLimit from "express-rate-limit"
import { listOrders, createOrder, getOrderById, updateOrderStatus, deleteOrdersBySession, markPaid, sendReceipt, saveReceiptEmail, reconcileComplete } from "../controllers/orderController.js"
import { reorderFromOrder } from "../controllers/reorderController.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

// Limit receipt emails to curb spam/abuse of the email provider.
const receiptLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many receipt requests. Please try again shortly." },
})

/**
 * @openapi
 * /orders/:
 *   get:
 *     summary: Retrieve a list of orders (filtered by query parameters)
 *     tags:
 *       - Orders
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: tableNumber
 *         schema:
 *           type: string
 *       - in: query
 *         name: sessionId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of orders
 */
router.get("/", listOrders)

/**
 * @openapi
 * /orders/:
 *   post:
 *     summary: Place a new order
 *     tags:
 *       - Orders
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - tableNumber
 *               - items
 *             properties:
 *               businessId:
 *                 type: string
 *               tableNumber:
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
router.post("/", createOrder)

/**
 * @openapi
 * /orders/session:
 *   delete:
 *     summary: Delete/clear order sessions
 *     tags:
 *       - Orders
 *     parameters:
 *       - in: query
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Orders session deleted
 */
router.delete("/session", requireAuth, requireRole("owner", "admin", "manager"), deleteOrdersBySession)

/**
 * @openapi
 * /orders/{orderId}:
 *   get:
 *     summary: Get details of an order by ID
 *     tags:
 *       - Orders
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 *       404:
 *         description: Order not found
 */
router.get("/:orderId", getOrderById)

/**
 * @openapi
 * /orders/{orderId}/reorder:
 *   post:
 *     summary: Validate a previous order against the current menu and return a cart-ready payload
 *     tags:
 *       - Orders
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
 *               - businessId
 *             properties:
 *               businessId:
 *                 type: string
 *               sessionId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reorder payload with available items and unavailable item names
 */
router.post("/:orderId/reorder", reorderFromOrder)

/**
 * @openapi
 * /orders/{orderId}/status:
 *   patch:
 *     summary: Update status of an order (Waiter/Kitchen/Bar only)
 *     tags:
 *       - Orders
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
 *         description: Status updated successfully
 */
router.patch("/:orderId/status", requireAuth, requireRole("waiter", "kitchen", "bar"), updateOrderStatus)

/**
 * @openapi
 * /orders/{orderId}/mark-paid:
 *   patch:
 *     summary: Mark an order as paid (Waiter only)
 *     tags:
 *       - Orders
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
 *         description: Order marked paid
 */
router.patch("/:orderId/mark-paid", requireAuth, requireRole("waiter", "manager", "owner", "co_owner"), markPaid)

/**
 * @openapi
 * /orders/{orderId}/receipt:
 *   post:
 *     summary: Send digital receipt to email
 *     tags:
 *       - Orders
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
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Receipt sent
 */
router.post("/:orderId/receipt", receiptLimiter, requireAuth, requireRole("waiter", "owner", "admin", "manager"), sendReceipt)

/**
 * @openapi
 * /orders/{orderId}/reconcile-complete:
 *   patch:
 *     summary: Operational recovery - mark an order as completed (after-shift reconciliation)
 *     tags:
 *       - Orders
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order marked as completed
 *       400:
 *         description: Invalid transition (already completed, cancelled, or wrong status)
 *       409:
 *         description: Concurrent update conflict
 */
router.patch("/:orderId/reconcile-complete", requireAuth, requireRole("waiter", "manager", "owner", "co_owner"), reconcileComplete)

/**
 * @openapi
 * /orders/{orderId}/receipt-email:
 *   patch:
 *     summary: Save receipt email for future references
 *     tags:
 *       - Orders
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
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email saved successfully
 */
router.patch("/:orderId/receipt-email", saveReceiptEmail)

export default router
