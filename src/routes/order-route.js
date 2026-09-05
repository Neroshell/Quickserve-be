import express from "express"
import rateLimit from "express-rate-limit"
import { listOrders, createOrder, getOrderById, updateOrderStatus, deleteOrdersBySession, markPaid, sendReceipt, saveReceiptEmail, reconcileComplete } from "../controllers/orderController.js"
import { reorderFromOrder } from "../controllers/reorderController.js"
import { requireAuth, requirePermissionForAuthenticatedManager, requireRole } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"

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
 *         name: servicePointLabel
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
router.get("/", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_VIEW), listOrders)

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
 *               - servicePointLabel
 *               - items
 *             properties:
 *               businessId:
 *                 type: string
 *               servicePointLabel:
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
router.post("/", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), createOrder)

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
router.delete("/session", requireAuth, requireRole("owner", "co_owner", "admin", "manager"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), deleteOrdersBySession)

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
router.get("/:orderId", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_VIEW), getOrderById)

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
router.post(
  "/:orderId/reorder",
  requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_VIEW),
  reorderFromOrder,
)

/**
 * @openapi
 * /orders/{orderId}/status:
 *   patch:
 *     summary: Perform the final ready-to-served handoff (Waitstaff/management)
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
 *                 enum: [completed]
 *     responses:
 *       200:
 *         description: Status updated successfully
 */
router.patch("/:orderId/status", requireAuth, requireRole("waiter", "manager", "owner", "co_owner"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), updateOrderStatus)

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
router.patch("/:orderId/mark-paid", requireAuth, requireRole("waiter", "manager", "owner", "co_owner"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), markPaid)

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
router.post("/:orderId/receipt", receiptLimiter, requireAuth, requireRole("waiter", "owner", "co_owner", "admin", "manager"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), sendReceipt)

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
router.patch("/:orderId/reconcile-complete", requireAuth, requireRole("waiter", "manager", "owner", "co_owner"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), reconcileComplete)

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
router.patch("/:orderId/receipt-email", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), saveReceiptEmail)

export default router
