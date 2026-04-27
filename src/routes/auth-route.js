import express from "express";
import rateLimit from "express-rate-limit";
import { validateInviteToken, setupOwnerPassword, loginUser, getMe, requestPasswordReset, resetPassword } from "../controllers/authController.js";

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per minute
  message: { message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
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
