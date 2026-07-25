import express from "express"
import { createBusiness, getAdminBusinesses, getAdminOwners, createAdminOwner, getAdminBusinessById, updateAdminBusiness, getAdminDashboardStats, deleteAdminBusiness, getAdminBusinessModuleCatalog } from "../controllers/businessController.js"
import { getPlans, updatePlan } from "../controllers/planController.js"

import { requirePlatformAdmin } from "../middleware/platformAdminAuth.js"

const router = express.Router()

// Platform admin (QuickServe backoffice) only — Supabase bearer token + email allowlist.
// This is separate from tenant owner/manager/staff auth.
router.use(requirePlatformAdmin)

router.get("/business-modules", getAdminBusinessModuleCatalog)

/**
 * @openapi
 * /admin/businesses:
 *   post:
 *     summary: Create a new business (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - displayName
 *               - slug
 *               - ownerEmail
 *             properties:
 *               name:
 *                 type: string
 *               displayName:
 *                 type: string
 *               slug:
 *                 type: string
 *               ownerEmail:
 *                 type: string
 *               ownerName:
 *                 type: string
 *     responses:
 *       201:
 *         description: Business created successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post("/businesses", createBusiness)

/**
 * @openapi
 * /admin/owners:
 *   post:
 *     summary: Create an admin/owner user (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - businessId
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               businessId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Owner created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/owners", createAdminOwner)

/**
 * @openapi
 * /admin/businesses:
 *   get:
 *     summary: List all businesses (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of businesses
 *       401:
 *         description: Unauthorized
 */
router.get("/businesses", getAdminBusinesses)

/**
 * @openapi
 * /admin/owners:
 *   get:
 *     summary: List all business owners (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of owners
 *       401:
 *         description: Unauthorized
 */
router.get("/owners", getAdminOwners)

/**
 * @openapi
 * /admin/dashboard-stats:
 *   get:
 *     summary: Get overview stats for backoffice dashboard (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 *       401:
 *         description: Unauthorized
 */
router.get("/dashboard-stats", getAdminDashboardStats)

/**
 * @openapi
 * /admin/businesses/{businessId}:
 *   get:
 *     summary: Get business details by ID (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Business details
 *       404:
 *         description: Business not found
 */
router.get("/businesses/:businessId", getAdminBusinessById)

/**
 * @openapi
 * /admin/businesses/{businessId}:
 *   patch:
 *     summary: Update business details (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: businessId
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
 *               displayName:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [draft, active, suspended, archived]
 *     responses:
 *       200:
 *         description: Business updated successfully
 *       404:
 *         description: Business not found
 */
router.patch("/businesses/:businessId", updateAdminBusiness)

/**
 * @openapi
 * /admin/businesses/{businessId}:
 *   delete:
 *     summary: Delete a business (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Business deleted successfully
 *       404:
 *         description: Business not found
 */
router.delete("/businesses/:businessId", deleteAdminBusiness)

/**
 * @openapi
 * /admin/plans:
 *   get:
 *     summary: Get all plans (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of pricing/billing plans
 */
router.get("/plans", getPlans)

/**
 * @openapi
 * /admin/plans/{id}:
 *   patch:
 *     summary: Update a pricing plan (Platform Admin Only)
 *     tags:
 *       - Admin
 *     security:
 *       - BearerAuth: []
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
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Plan updated successfully
 */
router.patch("/plans/:id", updatePlan)



export default router
