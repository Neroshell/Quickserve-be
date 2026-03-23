import express from "express"
import { createRestaurant, getAdminRestaurants, getAdminOwners, getAdminRestaurantById, updateAdminRestaurant, getAdminDashboardStats, deleteAdminRestaurant } from "../controllers/restaurantController.js"
import { getPlans, updatePlan, seedPlans } from "../controllers/planController.js"

const router = express.Router()

// POST /admin/restaurants
router.post("/restaurants", createRestaurant)

// GET /admin/restaurants
router.get("/restaurants", getAdminRestaurants)

// GET /admin/owners
router.get("/owners", getAdminOwners)

// GET /admin/dashboard-stats
router.get("/dashboard-stats", getAdminDashboardStats)

// GET /admin/restaurants/:restaurantId
router.get("/restaurants/:restaurantId", getAdminRestaurantById)

// PATCH /admin/restaurants/:restaurantId
router.patch("/restaurants/:restaurantId", updateAdminRestaurant)

// DELETE /admin/restaurants/:restaurantId
router.delete("/restaurants/:restaurantId", deleteAdminRestaurant)

// GET /admin/plans
router.get("/plans", getPlans)

// PATCH /admin/plans/:id
router.patch("/plans/:id", updatePlan)

// POST /admin/plans/seed
router.post("/plans/seed", seedPlans)

export default router
