import express from "express"
import {
    getMenuItems,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    toggleMenuItemAvailability,
    getPopularItems
} from "../controllers/menuController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

const requireManager = [requireAuth, requireRole("owner", "admin", "manager")]

/**
 * @openapi
 * /menu-items/popular:
 *   get:
 *     summary: Retrieve popular menu items for a business
 *     tags:
 *       - Menu Items
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of popular menu items
 */
router.get("/popular", getPopularItems)

/**
 * @openapi
 * /menu-items/:
 *   get:
 *     summary: Get all menu items for a business
 *     tags:
 *       - Menu Items
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of menu items
 */
router.get("/", getMenuItems)


/**
 * @openapi
 * /menu-items/:
 *   post:
 *     summary: Create a new menu item
 *     tags:
 *       - Menu Items
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - name
 *               - price
 *               - prepTimeMinutes
 *               - category
 *               - type
 *             properties:
 *               businessId:
 *                 type: string
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               prepTimeMinutes:
 *                 type: integer
 *                 minimum: 1
 *                 description: Estimated preparation time in whole minutes
 *               category:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [food, drinks]
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Menu item created successfully
 */
router.post("/", requireManager, createMenuItem)

/**
 * @openapi
 * /menu-items/{id}:
 *   patch:
 *     summary: Update an existing menu item
 *     tags:
 *       - Menu Items
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               prepTimeMinutes:
 *                 type: integer
 *                 minimum: 1
 *                 description: Estimated preparation time in whole minutes
 *               description:
 *                 type: string
 *               isAvailable:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Menu item updated successfully
 */
router.patch("/:id", requireManager, updateMenuItem)

/**
 * @openapi
 * /menu-items/{id}:
 *   delete:
 *     summary: Delete a menu item
 *     tags:
 *       - Menu Items
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Menu item deleted successfully
 */
router.delete("/:id", requireManager, deleteMenuItem)

/**
 * @openapi
 * /menu-items/{id}/availability:
 *   patch:
 *     summary: Toggle availability of a menu item
 *     tags:
 *       - Menu Items
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Menu item availability toggled successfully
 */
router.patch("/:id/availability", requireManager, toggleMenuItemAvailability)

export default router
