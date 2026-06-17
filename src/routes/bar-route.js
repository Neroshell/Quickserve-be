import express from "express"
import { barOrders } from "../controllers/barController.js"

const router = express.Router()

/**
 * @openapi
 * /bar/orders:
 *   get:
 *     summary: Retrieve active drink orders for the bar view
 *     tags:
 *       - Bar
 *     responses:
 *       200:
 *         description: List of bar orders
 */
router.get("/orders", barOrders)

export default router
