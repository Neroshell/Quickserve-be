import express from "express"
import { listOrders, createOrder, getOrderById, updateOrderStatus, deleteOrdersBySession } from "../controllers/orderController.js"

const router = express.Router()

router.get("/", listOrders)
router.post("/", createOrder)
router.delete("/session", deleteOrdersBySession)
router.get("/:orderId", getOrderById)
router.patch("/:orderId/status", updateOrderStatus)
router.delete("/session", deleteOrdersBySession)

export default router
