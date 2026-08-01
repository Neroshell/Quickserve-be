import express from "express"
import { ownerOrders, ownerTransactions, getTableSessionsOverview, getDashboardData, getBranding, updateBranding } from "../controllers/ownerController.js"
import { ownerAnalytics } from "../controllers/ownerAnalyticsController.js"
import { dismissSetupGuide, getSetupProgress } from "../controllers/setupProgressController.js"
import { getOwnerFeedbackAnalytics } from "../controllers/feedbackController.js"
import { getTeam, inviteCoOwner, removeCoOwner } from "../controllers/teamController.js"
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
    toggleReservableServicePoint,
    deleteServicePoint,
} from "../controllers/servicePointController.js"
import {
    getReservations,
    updateReservationStatus,
    checkInHotelReservation,
    deleteReservation,
    resendReservationConfirmation,
    resendReservationPaymentLink
} from "../controllers/reservationController.js"
import { cancelOwnerHotelReservation } from "../controllers/reservationCancellationController.js"

import { requireAuth, requirePrimaryOwner, requireOwnerOrCoOwner } from "../middleware/authMiddleware.js"
import { connectAccount, getStripeStatus, getStripeDashboardLink, getPayoutSummary } from "../controllers/stripeConnectController.js"
import {
    getBillingOverview,
    createSetupIntent,
    verifyPaymentMethod,
    deletePaymentMethod,
    updatePlan,
    getCommissionSummary,
    getInvoices,
    archiveInvoice,
    updatePlatformFeeSettings,
    reportOfflineUsage
} from "../controllers/billingController.js"

const router = express.Router()
router.use(requireAuth, requireOwnerOrCoOwner)

// ─── Branding ─────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /owner/branding:
 *   get:
 *     summary: Retrieve branding information for the owner's business
 *     tags:
 *       - Owner Branding
 *     responses:
 *       200:
 *         description: Current branding configuration
 */
router.get("/branding", getBranding)

/**
 * @openapi
 * /owner/branding:
 *   patch:
 *     summary: Update branding preferences for the owner's business
 *     tags:
 *       - Owner Branding
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               primaryColor:
 *                 type: string
 *               secondaryColor:
 *                 type: string
 *               accentColor:
 *                 type: string
 *               backgroundColor:
 *                 type: string
 *               removeQuickServeBranding:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Branding preferences updated successfully
 */
router.patch("/branding", updateBranding)

// ─── Dashboard & Analytics ───────────────────────────────────────────────────

/**
 * @openapi
 * /owner/orders:
 *   get:
 *     summary: Get all orders for the owner's business
 *     tags:
 *       - Owner Core
 *     responses:
 *       200:
 *         description: List of orders
 */
router.get("/orders", ownerOrders)
router.get("/transactions", ownerTransactions)

/**
 * @openapi
 * /owner/dashboard:
 *   get:
 *     summary: Retrieve owner overview command center dashboard data
 *     tags:
 *       - Owner Core
 *     responses:
 *       200:
 *         description: Main dashboard analytics and status counters
 */
router.get("/dashboard", getDashboardData)
router.get("/setup-progress", getSetupProgress)
router.post("/setup-progress/dismiss", requirePrimaryOwner, dismissSetupGuide)

/**
 * @openapi
 * /owner/analytics:
 *   get:
 *     summary: Get channel breakdowns and historical analytics
 *     tags:
 *       - Owner Core
 *     responses:
 *       200:
 *         description: Analytical graphs and stats
 */
router.get("/analytics", ownerAnalytics)

/**
 * @openapi
 * /owner/table-sessions/overview:
 *   get:
 *     summary: Retrieve overview of active table/QR sessions
 *     tags:
 *       - Owner Core
 *     responses:
 *       200:
 *         description: Table sessions status
 */
router.get("/table-sessions/overview", getTableSessionsOverview)

/**
 * @openapi
 * /owner/feedback:
 *   get:
 *     summary: Get list and metrics of customer feedback submissions
 *     tags:
 *       - Owner Core
 *     responses:
 *       200:
 *         description: Feedback analytics
 */
router.get("/feedback", getOwnerFeedbackAnalytics)

// ─── Staff Management (unified, multi-role) ───────────────────────────────────

/**
 * @openapi
 * /owner/staff:
 *   get:
 *     summary: List all staff members for the business
 *     tags:
 *       - Owner Staff Management
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [waiter, kitchen, manager]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, offline]
 *     responses:
 *       200:
 *         description: List of staff members
 */
router.get("/staff", getStaff)

/**
 * @openapi
 * /owner/staff:
 *   post:
 *     summary: Invite/create a new staff member
 *     tags:
 *       - Owner Staff Management
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - role
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [waiter, kitchen, manager]
 *     responses:
 *       201:
 *         description: Staff invited successfully
 */
router.post("/staff", createStaff)

/**
 * @openapi
 * /owner/staff/{staffId}:
 *   delete:
 *     summary: Delete a staff member by ID
 *     tags:
 *       - Owner Staff Management
 *     parameters:
 *       - in: path
 *         name: staffId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Staff member deleted successfully
 */
router.delete("/staff/:staffId", deleteStaff)

// ─── Team & Access (Primary Owner Only) ───────────────────────────────────────

/**
 * @openapi
 * /owner/team:
 *   get:
 *     summary: List business co-owners and admins (Primary Owner Only)
 *     tags:
 *       - Owner Team Management
 *     responses:
 *       200:
 *         description: List of team owners/co-owners
 */
router.get("/team", requirePrimaryOwner, getTeam)

/**
 * @openapi
 * /owner/team/co-owner:
 *   post:
 *     summary: Invite a new co-owner (Primary Owner Only)
 *     tags:
 *       - Owner Team Management
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       201:
 *         description: Co-owner invite sent successfully
 */
router.post("/team/co-owner", requirePrimaryOwner, inviteCoOwner)

/**
 * @openapi
 * /owner/team/co-owner/{staffId}:
 *   delete:
 *     summary: Remove a co-owner by ID (Primary Owner Only)
 *     tags:
 *       - Owner Team Management
 *     parameters:
 *       - in: path
 *         name: staffId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Co-owner removed successfully
 */
router.delete("/team/co-owner/:staffId", requirePrimaryOwner, removeCoOwner)

// ─── Legacy Waitstaff routes (backward compat — do NOT remove) ────────────────

/**
 * @openapi
 * /owner/staff:
 *   get:
 *     summary: Retrieve legacy waitstaff list (Backward Compatibility)
 *     tags:
 *       - Owner Staff Management (Legacy)
 *     responses:
 *       200:
 *         description: List of waiters
 */
router.get("/staff", getWaiters)

/**
 * @openapi
 * /owner/staff:
 *   post:
 *     summary: Create legacy waiter account (Backward Compatibility)
 *     tags:
 *       - Owner Staff Management (Legacy)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       201:
 *         description: Waiter created successfully
 */
router.post("/staff", createWaiter)

/**
 * @openapi
 * /owner/staff/{id}:
 *   delete:
 *     summary: Delete legacy waiter account (Backward Compatibility)
 *     tags:
 *       - Owner Staff Management (Legacy)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Waiter deleted successfully
 */
router.delete("/staff/:id", deleteWaiter)

// ─── Service Point Management ─────────────────────────────────────────────────

/**
 * @openapi
 * /owner/service-points:
 *   get:
 *     summary: List all ServicePoints
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: query
 *         name: active
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: List of service points
 */
router.get("/service-points", listServicePoints)

/**
 * @openapi
 * /owner/service-points:
 *   post:
 *     summary: Create a new ServicePoint
 *     tags:
 *       - Owner Service Points
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - label
 *             properties:
 *               label:
 *                 type: string
 *               code:
 *                 type: string
 *               capacity:
 *                 type: number
 *               servicePointType:
 *                 type: string
 *                 enum: [table, room]
 *                 default: table
 *     responses:
 *       201:
 *         description: Service point created successfully
 */
router.post("/service-points", createServicePoint)

/**
 * @openapi
 * /owner/service-points/{servicePointId}:
 *   get:
 *     summary: Get service point details by ID
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: path
 *         name: servicePointId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service point details
 */
router.get("/service-points/:servicePointId", getServicePoint)

/**
 * @openapi
 * /owner/service-points/{servicePointId}:
 *   patch:
 *     summary: Update service point details
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: path
 *         name: servicePointId
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
 *               label:
 *                 type: string
 *               code:
 *                 type: string
 *               capacity:
 *                 type: number
 *     responses:
 *       200:
 *         description: Service point updated successfully
 */
router.patch("/service-points/:servicePointId", updateServicePoint)

/**
 * @openapi
 * /owner/service-points/{servicePointId}/toggle:
 *   patch:
 *     summary: Toggle active state of a service point
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: path
 *         name: servicePointId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service point state toggled successfully
 */
router.patch("/service-points/:servicePointId/toggle", toggleServicePoint)

/**
 * @openapi
 * /owner/service-points/{servicePointId}/toggle-reservable:
 *   patch:
 *     summary: Toggle reservable state of a service point
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: path
 *         name: servicePointId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Reservable state toggled successfully
 */
router.patch("/service-points/:servicePointId/toggle-reservable", toggleReservableServicePoint)

/**
 * @openapi
 * /owner/service-points/{servicePointId}:
 *   delete:
 *     summary: Delete a service point
 *     tags:
 *       - Owner Service Points
 *     parameters:
 *       - in: path
 *         name: servicePointId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service point deleted successfully
 */
router.delete("/service-points/:servicePointId", deleteServicePoint)

// ─── Reservations ─────────────────────────────────────────────────────────────

/**
 * @openapi
 * /owner/reservations:
 *   get:
 *     summary: List all reservations
 *     tags:
 *       - Owner Reservations
 *     responses:
 *       200:
 *         description: List of reservations
 */
router.get("/reservations", getReservations)

/**
 * @openapi
 * /owner/reservations/{id}/status:
 *   patch:
 *     summary: Update reservation status
 *     tags:
 *       - Owner Reservations
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
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, seated, completed, cancelled, no_show, accepted_awaiting_payment, expired, checked_out]
 *               cancellationReason:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Reservation status updated successfully
 */
router.patch("/reservations/:id/status", updateReservationStatus)

/**
 * @openapi
 * /owner/reservations/{id}/cancel:
 *   post:
 *     summary: Cancel a hotel reservation with explicit payment handling
 *     tags:
 *       - Owner Reservations
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Cancellation completed
 *       202:
 *         description: Refund accepted and pending provider completion
 *       403:
 *         description: Refund permission denied
 *       409:
 *         description: Reservation or payment state conflict
 */
router.post("/reservations/:id/cancel", cancelOwnerHotelReservation)

/**
 * @openapi
 * /owner/reservations/{id}/check-in:
 *   post:
 *     summary: Check in a hotel guest using their six-digit confirmation code
 *     tags:
 *       - Owner Reservations
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
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 pattern: '^\\d{6}$'
 *                 example: '123456'
 *     responses:
 *       200:
 *         description: Guest checked in successfully
 *       401:
 *         description: Incorrect check-in code
 *       409:
 *         description: Reservation is not eligible or the code is not active yet
 *       423:
 *         description: Check-in code is locked
 */
router.post("/reservations/:id/check-in", checkInHotelReservation)

/**
 * @openapi
 * /owner/reservations/{id}:
 *   delete:
 *     summary: Remove a terminal reservation from operational views
 *     tags:
 *       - Owner Reservations
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Reservation archived successfully
 */
router.delete("/reservations/:id", deleteReservation)

/**
 * @openapi
 * /owner/reservations/{id}/resend-confirmation:
 *   post:
 *     summary: Resend hotel payment confirmation email with a new check-in code
 *     tags:
 *       - Owner Reservations
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Confirmation email resent successfully
 *       400:
 *         description: Reservation not eligible
 *       404:
 *         description: Reservation not found
 */
router.post("/reservations/:id/resend-confirmation", resendReservationConfirmation)

/**
 * @openapi
 * /owner/reservations/{id}/resend-payment-link:
 *   post:
 *     summary: Resend an active hotel reservation payment link
 *     tags:
 *       - Owner Reservations
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment link resent successfully
 *       409:
 *         description: Reservation is not awaiting payment or the link expired
 */
router.post("/reservations/:id/resend-payment-link", resendReservationPaymentLink)


// ─── Stripe Connect ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /owner/stripe/connect-account:
 *   post:
 *     summary: Onboard or link business Stripe connected Express account (Primary Owner Only)
 *     tags:
 *       - Owner Stripe Connect
 *     responses:
 *       200:
 *         description: Stripe onboarding session URL link
 */
router.post("/stripe/connect-account", requirePrimaryOwner, connectAccount)

/**
 * @openapi
 * /owner/stripe/status:
 *   get:
 *     summary: Retrieve status of linked Stripe connected account (Primary Owner Only)
 *     tags:
 *       - Owner Stripe Connect
 *     responses:
 *       200:
 *         description: Stripe integration status metrics
 */
router.get("/stripe/status", requirePrimaryOwner, getStripeStatus)

/**
 * @openapi
 * /owner/stripe/dashboard-link:
 *   get:
 *     summary: Generate a single-use login link to the Stripe Express Dashboard (Primary Owner Only)
 *     tags:
 *       - Owner Stripe Connect
 *     responses:
 *       200:
 *         description: Dashboard login link
 */
router.get("/stripe/dashboard-link", requirePrimaryOwner, getStripeDashboardLink)
router.get("/stripe/payout-summary", requirePrimaryOwner, getPayoutSummary)

// ─── QuickServe Billing (MVP) ────────────────────────────────────────────────

/**
 * @openapi
 * /owner/billing:
 *   get:
 *     summary: Get billing overview details (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: Platform billing configuration, metrics, and state
 */
router.get("/billing", requirePrimaryOwner, getBillingOverview)

/**
 * @openapi
 * /owner/billing/setup-intent:
 *   post:
 *     summary: Create a Stripe SetupIntent for adding credit cards (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: SetupIntent client secret credentials
 */
router.post("/billing/setup-intent", requirePrimaryOwner, createSetupIntent)

/**
 * @openapi
 * /owner/billing/verify-payment-method:
 *   post:
 *     summary: Confirm and verify a Stripe PaymentMethod (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - paymentMethodId
 *             properties:
 *               paymentMethodId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment method saved successfully
 */
router.post("/billing/verify-payment-method", requirePrimaryOwner, verifyPaymentMethod)

/**
 * @openapi
 * /owner/billing/payment-method:
 *   delete:
 *     summary: Remove the default payment method (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: Payment method detached successfully
 */
router.delete("/billing/payment-method", requirePrimaryOwner, deletePaymentMethod)

/**
 * @openapi
 * /owner/billing/plan:
 *   post:
 *     summary: Upgrade/downgrade subscription plan (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [basic, growth, pro]
 *     responses:
 *       200:
 *         description: Plan updated successfully
 */
router.post("/billing/plan", requirePrimaryOwner, updatePlan)

/**
 * @openapi
 * /owner/billing/commission:
 *   get:
 *     summary: Get commission summary for offline sales (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: Accumulated platform commission info
 */
router.get("/billing/commission", requirePrimaryOwner, getCommissionSummary)

/**
 * @openapi
 * /owner/billing/invoices:
 *   get:
 *     summary: Retrieve history of platform billing invoices (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: List of invoices
 */
router.get("/billing/invoices", requirePrimaryOwner, getInvoices)

/**
 * @openapi
 * /owner/billing/invoices/{id}:
 *   delete:
 *     summary: Archive a platform invoice (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Invoice archived successfully
 */
router.delete("/billing/invoices/:id", requirePrimaryOwner, archiveInvoice)

/**
 * @openapi
 * /owner/billing/platform-fee-settings:
 *   patch:
 *     summary: Configure customer platform fee sharing settings (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               passPlatformFeeToCustomer:
 *                 type: boolean
 *               platformFeeLabel:
 *                 type: string
 *     responses:
 *       200:
 *         description: Platforms fees configurations updated
 */
router.patch("/billing/platform-fee-settings", requirePrimaryOwner, updatePlatformFeeSettings)

/**
 * @openapi
 * /owner/billing/report-usage:
 *   post:
 *     summary: Submit/report offline metered sales volume (Primary Owner Only)
 *     tags:
 *       - Owner Billing
 *     responses:
 *       200:
 *         description: Usage reported successfully
 */
router.post("/billing/report-usage", requirePrimaryOwner, reportOfflineUsage)

export default router
