
import express from "express"
import { getOrderById, updateOrderStatus, markPaid, sendReceipt, saveReceiptEmail } from "../controllers/orderController.js"

const router = express.Router({ mergeParams: true })

/**
 * Scoped Routes: /businesses/:businessId/orders/...
 */

router.get("/:orderId", getOrderById)
router.patch("/:orderId/status", updateOrderStatus)
router.patch("/:orderId/mark-paid", markPaid)
router.post("/:orderId/receipt", sendReceipt)
router.patch("/:orderId/receipt-email", saveReceiptEmail)

export default router
