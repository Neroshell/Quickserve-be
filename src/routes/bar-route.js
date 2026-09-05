import express from "express"
import { barOrders, updateBarFulfillment } from "../controllers/barController.js"
import { requireAuth, requirePermissionForAuthenticatedManager, requireRole } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"

const router = express.Router()

// Bar display is staff-only (bartenders, plus managers/owners who may monitor it).
router.use(requireAuth, requireRole("bartender", "manager", "owner", "co_owner", "admin"))

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
router.get("/orders", requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_VIEW), barOrders)
router.patch(
    "/orders/:orderId/fulfillment",
    requirePermissionForAuthenticatedManager(PERMISSIONS.ORDERS_MANAGE),
    updateBarFulfillment,
)

export default router
