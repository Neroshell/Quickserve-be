import express from "express";
import rateLimit from "express-rate-limit";
import { validateInviteToken, setupOwnerPassword, loginUser, getMe, requestPasswordReset, resetPassword } from "../controllers/authController.js";

const router = express.Router();

// Strict rate limiter for sensitive auth endpoints
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 15-minute window
  max: 5, // Max 5 attempts per IP per window
  message: { message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed requests against the limit
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
router.get("/invite/validate", validateInviteToken);

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
router.post("/invite/setup-password", setupOwnerPassword);

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
router.post("/login", authLimiter, loginUser);

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
router.get("/me", getMe);

import { validateStaffToken, setupStaffPassword, logoutUser } from "../controllers/authController.js";

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
router.get("/invite/staff/validate", validateStaffToken);

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
router.post("/invite/staff/setup-password", setupStaffPassword);

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

export default router;
