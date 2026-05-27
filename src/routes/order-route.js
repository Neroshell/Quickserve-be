import express from "express"
import { listOrders, createOrder, getOrderById, updateOrderStatus, deleteOrdersBySession, markPaid, sendReceipt, saveReceiptEmail } from "../controllers/orderController.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

router.get("/", listOrders)
router.post("/", createOrder)
router.delete("/session", deleteOrdersBySession)
router.get("/:orderId", getOrderById)
router.patch("/:orderId/status", requireAuth, requireRole("waiter", "kitchen", "bar"), updateOrderStatus)
router.patch("/:orderId/mark-paid", requireAuth, requireRole("waiter"), markPaid)
router.post("/:orderId/receipt", sendReceipt)
router.patch("/:orderId/receipt-email", saveReceiptEmail)
// router.delete("/session", deleteOrdersBySession)

export default router
