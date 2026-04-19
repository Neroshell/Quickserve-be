import express from "express";
import { validateInviteToken, setupOwnerPassword, loginUser, getMe } from "../controllers/authController.js";

const router = express.Router();

// GET /auth/invite/validate?token=...
router.get("/invite/validate", validateInviteToken);

// POST /auth/invite/setup-password
router.post("/invite/setup-password", setupOwnerPassword);

// POST /auth/login
router.post("/login", loginUser);

// GET /auth/me
router.get("/me", getMe);

// GET /auth/invite/staff/validate?token=...
import { validateStaffToken, setupStaffPassword, logoutUser } from "../controllers/authController.js";
router.get("/invite/staff/validate", validateStaffToken);

// POST /auth/invite/staff/setup-password
router.post("/invite/staff/setup-password", setupStaffPassword);

// POST /auth/logout
router.post("/logout", logoutUser);

export default router;
