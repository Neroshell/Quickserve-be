import express from "express"
import { getSettings, updateSettings, updateOwnerBusinessModules, updateOperatingHours, updateOrderingPreferences, updatePaymentPreferences, updateTablePreferences, getCategories, addCategory, removeCategory, addHotelRoomType, removeHotelRoomType } from "../controllers/businessController.js"

import { requireAnyPermission, requireAuth, requirePermission, requirePermissionForAuthenticatedManager, requireRole } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"

const router = express.Router()

const requireOperationalSettingsManager = [
    requireAuth,
    requireRole("owner", "admin", "manager"),
    requirePermission(PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE),
]
const requireManagementSettingsRead = [
    requireAuth,
    requireRole("owner", "admin", "manager"),
    requireAnyPermission(
        PERMISSIONS.TRANSACTIONS_VIEW,
        PERMISSIONS.RESERVATIONS_VIEW,
        PERMISSIONS.SERVICE_POINTS_VIEW,
        PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE,
    ),
]
const requireBusinessIdentityOwner = [requireAuth, requireRole("owner", "admin")]
const requireOwner = [requireAuth, requireRole("owner", "co_owner")]

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
router.get("/settings", requireManagementSettingsRead, getSettings)

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
router.patch("/settings", requireBusinessIdentityOwner, updateSettings)

/**
 * Hotel owners can add or remove Food Service without changing the hotel's
 * business identity or its required Lodging module.
 */
router.patch("/settings/modules", requireOwner, updateOwnerBusinessModules)

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
router.patch("/operating-hours", requireOperationalSettingsManager, updateOperatingHours)

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
router.patch("/settings/ordering-preferences", requireOperationalSettingsManager, updateOrderingPreferences)

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
router.patch("/settings/payment-preferences", requireOperationalSettingsManager, updatePaymentPreferences)

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
router.patch("/settings/table-preferences", requireOperationalSettingsManager, updateTablePreferences)

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
router.get("/categories", requirePermissionForAuthenticatedManager(PERMISSIONS.MENU_VIEW), getCategories)

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
router.post("/categories", requireOperationalSettingsManager, addCategory)

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
router.delete("/categories", requireOperationalSettingsManager, removeCategory)

/**
 * @openapi
 * /business/room-types:
 *   post:
 *     summary: Add a custom hotel room type (Owner only)
 *     tags:
 *       - Business Settings
 */
router.post("/room-types", requireOwner, addHotelRoomType)
router.delete("/room-types", requireOwner, removeHotelRoomType)

export default router
