import express from "express"
import { getSettings, updateSettings, updateOperatingHours, updateOrderingPreferences, updatePaymentPreferences, updateTablePreferences, getCategories, addCategory, removeCategory } from "../controllers/businessController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

const requireManager = [requireAuth, requireRole("owner", "admin", "manager")]

/**
 * @openapi
 * /business/settings:
 *   get:
 *     summary: Get business configuration settings (Manager only)
 *     tags:
 *       - Business Settings
 *     responses:
 *       200:
 *         description: Current business configurations
 */
router.get("/settings", requireManager, getSettings)

/**
 * @openapi
 * /business/settings:
 *   patch:
 *     summary: Update primary business configuration details (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               displayName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Settings updated successfully
 */
router.patch("/settings", requireManager, updateSettings)

/**
 * @openapi
 * /business/operating-hours:
 *   patch:
 *     summary: Update business weekly operating hours (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Operating hours updated successfully
 */
router.patch("/operating-hours", requireManager, updateOperatingHours)

/**
 * @openapi
 * /business/settings/ordering-preferences:
 *   patch:
 *     summary: Update ordering features/preferences (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Ordering preferences updated successfully
 */
router.patch("/settings/ordering-preferences", requireManager, updateOrderingPreferences)

/**
 * @openapi
 * /business/settings/payment-preferences:
 *   patch:
 *     summary: Update payment channel settings (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Payment preferences updated successfully
 */
router.patch("/settings/payment-preferences", requireManager, updatePaymentPreferences)

/**
 * @openapi
 * /business/settings/table-preferences:
 *   patch:
 *     summary: Update table session preferences (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Table preferences updated successfully
 */
router.patch("/settings/table-preferences", requireManager, updateTablePreferences)

/**
 * @openapi
 * /business/categories:
 *   get:
 *     summary: Get all custom menu categories configured
 *     tags:
 *       - Business Settings
 *     parameters:
 *       - in: query
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of categories
 */
router.get("/categories", getCategories)

/**
 * @openapi
 * /business/categories:
 *   post:
 *     summary: Add a new custom category (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - category
 *             properties:
 *               category:
 *                 type: string
 *     responses:
 *       201:
 *         description: Category added successfully
 */
router.post("/categories", requireManager, addCategory)

/**
 * @openapi
 * /business/categories:
 *   delete:
 *     summary: Remove a custom category (Manager only)
 *     tags:
 *       - Business Settings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - category
 *             properties:
 *               category:
 *                 type: string
 *     responses:
 *       200:
 *         description: Category removed successfully
 */
router.delete("/categories", requireManager, removeCategory)

export default router
