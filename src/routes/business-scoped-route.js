import express from "express"
import { getOrderById, updateOrderStatus, markPaid, sendReceipt, saveReceiptEmail } from "../controllers/orderController.js"
import { requireAuth, requirePermissionForAuthenticatedManager, requireRole } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"

const router = express.Router({ mergeParams: true })

/**
 * Scoped Routes: /businesses/:businessId/orders/...
 */

/**
 * @openapi
 * /businesses/{businessId}/orders/{orderId}:
 *   get:
 *     summary: Retrieve a business-scoped order by ID
 *     tags:
 *       - Business Scoped Orders
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 */
router.get("/:orderId", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_VIEW), getOrderById)

/**
 * @openapi
 * /businesses/{businessId}/orders/{orderId}/status:
 *   patch:
 *     summary: Update a business-scoped order's status
 *     tags:
 *       - Business Scoped Orders
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
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
router.patch("/:orderId/status", requireAuth, requireRole("owner", "admin", "manager", "waiter", "kitchen", "bar"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), updateOrderStatus)

/**
 * @openapi
 * /businesses/{businessId}/orders/{orderId}/mark-paid:
 *   patch:
 *     summary: Mark a business-scoped order as paid (Staff only)
 *     tags:
 *       - Business Scoped Orders
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
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
 *         description: Order marked paid successfully
 */
router.patch("/:orderId/mark-paid", requireAuth, requireRole("owner", "admin", "manager", "waiter"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), markPaid)

/**
 * @openapi
 * /businesses/{businessId}/orders/{orderId}/receipt:
 *   post:
 *     summary: Send digital receipt for a business-scoped order
 *     tags:
 *       - Business Scoped Orders
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
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
router.post("/:orderId/receipt", requireAuth, requireRole("owner", "admin", "manager", "waiter"), requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE), sendReceipt)

/**
 * @openapi
 * /businesses/{businessId}/orders/{orderId}/receipt-email:
 *   patch:
 *     summary: Save receipt email for business-scoped order
 *     tags:
 *       - Business Scoped Orders
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
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
