import express from "express"
import { createBusiness, getAdminBusinesses, getAdminOwners, createAdminOwner, getAdminBusinessById, updateAdminBusiness, getAdminDashboardStats, deleteAdminBusiness } from "../controllers/businessController.js"
import { getPlans, updatePlan, seedPlans } from "../controllers/planController.js"

import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()
router.use(requireAuth, requireRole("owner", "admin"))

// POST /admin/businesses
router.post("/businesses", createBusiness)

// POST /admin/owners
router.post("/owners", createAdminOwner)

// GET /admin/businesses
router.get("/businesses", getAdminBusinesses)

// GET /admin/owners
router.get("/owners", getAdminOwners)

// GET /admin/dashboard-stats
router.get("/dashboard-stats", getAdminDashboardStats)

// GET /admin/businesses/:businessId
router.get("/businesses/:businessId", getAdminBusinessById)

// PATCH /admin/businesses/:businessId
router.patch("/businesses/:businessId", updateAdminBusiness)

// DELETE /admin/businesses/:businessId
router.delete("/businesses/:businessId", deleteAdminBusiness)

// GET /admin/plans
router.get("/plans", getPlans)

// PATCH /admin/plans/:id
router.patch("/plans/:id", updatePlan)

// POST /admin/plans/seed
router.post("/plans/seed", seedPlans)

export default router
