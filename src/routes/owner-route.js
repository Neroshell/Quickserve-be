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
import {
    listServicePoints,
    getServicePoint,
    createServicePoint,
    updateServicePoint,
    toggleServicePoint,
    deleteServicePoint,
} from "../controllers/servicePointController.js"

import { requireAuth, requireOwner } from "../middleware/authMiddleware.js"
import { connectAccount, getStripeStatus, getStripeDashboardLink } from "../controllers/stripeConnectController.js"

const router = express.Router()
router.use(requireAuth, requireOwner)

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

// ─── Service Point Management ─────────────────────────────────────────────────
// businessId is always derived from the authenticated owner session — never from body/query

// GET    /owner/service-points[?active=true|false]
router.get("/service-points", listServicePoints)

// POST   /owner/service-points
// Body: { label, code?, capacity? }
router.post("/service-points", createServicePoint)

// GET    /owner/service-points/:servicePointId
router.get("/service-points/:servicePointId", getServicePoint)

// PATCH  /owner/service-points/:servicePointId
// Body: { label?, code?, capacity? }
router.patch("/service-points/:servicePointId", updateServicePoint)

// PATCH  /owner/service-points/:servicePointId/toggle  — flip isActive
router.patch("/service-points/:servicePointId/toggle", toggleServicePoint)

// DELETE /owner/service-points/:servicePointId
router.delete("/service-points/:servicePointId", deleteServicePoint)

// ─── Stripe Connect ───────────────────────────────────────────────────────────

// POST /owner/stripe/connect-account
// Creates or retrieves an Express connected account and returns an onboarding link.
router.post("/stripe/connect-account", connectAccount)

// GET /owner/stripe/status
// Fetches live status from Stripe and syncs it to the Business document.
router.get("/stripe/status", getStripeStatus)

// GET /owner/stripe/dashboard-link
// Creates a single-use Stripe Express dashboard login link for the connected account.
router.get("/stripe/dashboard-link", getStripeDashboardLink)

export default router
