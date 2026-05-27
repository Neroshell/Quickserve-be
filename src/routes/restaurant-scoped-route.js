import express from "express"
import { getOrderById, updateOrderStatus, markPaid, sendReceipt, saveReceiptEmail } from "../controllers/orderController.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router({ mergeParams: true })

/**
 * Scoped Routes: /businesses/:businessId/orders/...
 */

router.get("/:orderId", getOrderById)
router.patch("/:orderId/status", requireAuth, requireRole("owner", "admin", "manager", "waiter", "kitchen", "bar"), updateOrderStatus)
router.patch("/:orderId/mark-paid", requireAuth, requireRole("owner", "admin", "manager", "waiter"), markPaid)
router.post("/:orderId/receipt", sendReceipt)
router.patch("/:orderId/receipt-email", saveReceiptEmail)

export default router
