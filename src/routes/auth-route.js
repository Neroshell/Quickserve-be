import express from "express";
import { validateInviteToken, setupOwnerPassword, loginUser, getMe, requestPasswordReset, resetPassword, changePassword, changeEmail, confirmEmailChange } from "../controllers/authController.js";
import { coOwnerAccessSseHandler } from "../utils/sseManager.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import {
  createSharedSecurityRateLimit,
  getRequestIp,
  normalizeRateLimitEmail,
} from "../middleware/sharedSecurityRateLimit.js";

const router = express.Router();

const loginLimiter = createSharedSecurityRateLimit({
  scope: "auth-login",
  windowMs: 15 * 60 * 1000,
  getDimensions: (req) => [
    { name: "ip", value: getRequestIp(req), limit: 50 },
    { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 10 },
  ],
  message: "Too many login attempts. Please try again later.",
});

const inviteValidationLimiter = createSharedSecurityRateLimit({
  scope: "auth-invite-validation",
  windowMs: 15 * 60 * 1000,
  getDimensions: (req) => [
    { name: "ip", value: getRequestIp(req), limit: 100 },
    { name: "token", value: req.query?.token, limit: 20 },
  ],
});

const inviteSetupLimiter = createSharedSecurityRateLimit({
  scope: "auth-invite-setup",
  windowMs: 60 * 60 * 1000,
  getDimensions: (req) => [
    { name: "ip", value: getRequestIp(req), limit: 30 },
    { name: "token", value: req.body?.token, limit: 10 },
  ],
});

// Retain the canonical route name used by existing password/session regression
// coverage while replacing its process-local store with shared Redis counters.
const authLimiter = createSharedSecurityRateLimit({
  scope: "auth-credential-change",
  windowMs: 15 * 60 * 1000,
  getDimensions: (req) => [
    { name: "ip", value: getRequestIp(req), limit: 30 },
    {
      name: "subject",
      value: normalizeRateLimitEmail(req.body?.email || req.session?.user?.email) || req.body?.token,
      limit: 10,
    },
  ],
});

/**
 * @openapi
 * /auth/invite/validate:
 *   get:
 *     summary: Validate an owner invite token
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The invite token sent via email
 *     responses:
 *       200:
 *         description: Invite token is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 email:
 *                   type: string
 *       400:
 *         description: Invalid or expired token
 */
router.get("/invite/validate", inviteValidationLimiter, validateInviteToken);

/**
 * @openapi
 * /auth/invite/setup-password:
 *   post:
 *     summary: Set up password for the invited owner
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password setup completed successfully
 *       400:
 *         description: Missing fields or invalid token
 */
router.post("/invite/setup-password", inviteSetupLimiter, setupOwnerPassword);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Log in a user (Owner, Manager, Staff)
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logged in successfully
 *       401:
 *         description: Invalid email or password
 */
router.post("/login", loginLimiter, loginUser);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get the current authenticated user's session profile
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Current user session info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *       401:
 *         description: Unauthorized. Please log in.
 */
router.get("/me", requireAuth, getMe);

// Co-Owner permission changes are delivered as content-free invalidations.
// The client refetches /auth/me; backend route guards remain authoritative.
router.get("/access-events", requireAuth, requireRole("co_owner"), coOwnerAccessSseHandler);

import { validateStaffToken, setupStaffPassword, logoutUser, staffHeartbeat } from "../controllers/authController.js";

/**
 * @openapi
 * /auth/heartbeat:
 *   post:
 *     summary: Refresh staff presence TTL
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Heartbeat received successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/heartbeat", requireAuth, staffHeartbeat);

/**
 * @openapi
 * /auth/invite/staff/validate:
 *   get:
 *     summary: Validate a staff invite token
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The staff invite token
 *     responses:
 *       200:
 *         description: Token is valid
 *       400:
 *         description: Invalid or expired token
 */
router.get("/invite/staff/validate", inviteValidationLimiter, validateStaffToken);

/**
 * @openapi
 * /auth/invite/staff/setup-password:
 *   post:
 *     summary: Setup password for the invited staff member
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Staff password configured successfully
 *       400:
 *         description: Missing fields or invalid token
 */
router.post("/invite/staff/setup-password", inviteSetupLimiter, setupStaffPassword);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Log out the current user session
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post("/logout", logoutUser);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset email
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reset email sent if email exists
 */
router.post("/forgot-password", authLimiter, requestPasswordReset);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     summary: Reset password using the reset token
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - newPassword
 *             properties:
 *               token:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successful
 *       400:
 *         description: Invalid or expired token
 */
router.post("/reset-password", authLimiter, resetPassword);

/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     summary: Change password for currently authenticated user
 *     tags:
 *       - Auth
 */
router.post("/change-password", authLimiter, requireAuth, changePassword);

/**
 * @openapi
 * /auth/request-email-change:
 *   post:
 *     summary: Request email change — sends verification link to new address
 *     tags:
 *       - Auth
 */
router.post("/request-email-change", authLimiter, requireAuth, changeEmail);

/**
 * @openapi
 * /auth/confirm-email-change:
 *   get:
 *     summary: Confirm email change via magic link token (redirects to frontend)
 *     tags:
 *       - Auth
 */
router.get("/confirm-email-change", confirmEmailChange);

export default router;
