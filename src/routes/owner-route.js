import express from "express"
import { ownerOrders, ownerAnalytics, getTableSessionsOverview } from "../controllers/ownerController.js"
import {
    // Staff Management (new unified API)
    getStaff,
    createStaff,
    deleteStaff,
    // Legacy waiter routes (backward compat)
    getWaiters,
    createWaiter,
    deleteWaiter
} from "../controllers/staffController.js"

const router = express.Router()

// GET /owner/orders
router.get("/orders", ownerOrders)

// GET /owner/analytics
router.get("/analytics", ownerAnalytics)

// GET /owner/table-sessions/overview
router.get("/table-sessions/overview", getTableSessionsOverview)

// ─── Staff Management (unified, multi-role) ───────────────────────────────────
// Supports ?role=waiter|kitchen|manager&status=active|offline

// GET    /owner/staff
router.get("/staff", getStaff)

// POST   /owner/staff
// Body: { staffId?, name, email, role }
// role must be one of: waiter | kitchen | manager  (selected via card UI, not free-text)
router.post("/staff", createStaff)

// DELETE /owner/staff/:staffId
router.delete("/staff/:staffId", deleteStaff)

// ─── Legacy Waitstaff routes (backward compat — do NOT remove) ────────────────

// GET /owner/waiters?businessId=...
router.get("/waiters", getWaiters)

// POST /owner/waiters?businessId=...
router.post("/waiters", createWaiter)

// DELETE /owner/waiters/:id?businessId=...
router.delete("/waiters/:id", deleteWaiter)

export default router
