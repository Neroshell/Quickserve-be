import express from "express"
import { listOrders, createOrder, getOrderById, updateOrderStatus } from "../controllers/orderController.js"

const router = express.Router()

router.get("/", listOrders)
router.post("/", createOrder)
router.get("/:orderId", getOrderById)
router.patch("/:orderId/status", updateOrderStatus)

export default router
