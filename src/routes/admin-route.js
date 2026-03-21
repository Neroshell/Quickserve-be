import express from "express"
import { createRestaurant, getAdminRestaurants, getAdminOwners, getAdminRestaurantById, updateAdminRestaurant, getAdminDashboardStats } from "../controllers/restaurantController.js"

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

export default router
