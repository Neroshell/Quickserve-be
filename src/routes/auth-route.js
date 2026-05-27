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

// GET /auth/invite/validate?token=...
router.get("/invite/validate", validateInviteToken);

// POST /auth/invite/setup-password
router.post("/invite/setup-password", setupOwnerPassword);

// POST /auth/login
router.post("/login", authLimiter, loginUser);

// GET /auth/me
router.get("/me", getMe);

// GET /auth/invite/staff/validate?token=...
import { validateStaffToken, setupStaffPassword, logoutUser } from "../controllers/authController.js";
router.get("/invite/staff/validate", validateStaffToken);

// POST /auth/invite/staff/setup-password
router.post("/invite/staff/setup-password", setupStaffPassword);

// POST /auth/logout
router.post("/logout", logoutUser);

// POST /auth/forgot-password
router.post("/forgot-password", authLimiter, requestPasswordReset);

// POST /auth/reset-password
router.post("/reset-password", authLimiter, resetPassword);

export default router;
