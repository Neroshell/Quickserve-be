import express from "express";
import { validateInviteToken, setupOwnerPassword, loginUser } from "../controllers/authController.js";

const router = express.Router();

// GET /auth/invite/validate?token=...
router.get("/invite/validate", validateInviteToken);

// POST /auth/invite/setup-password
router.post("/invite/setup-password", setupOwnerPassword);

// POST /auth/login
router.post("/login", loginUser);

// GET /auth/invite/waiter/validate?token=...
import { validateWaiterToken, setupWaiterPassword, logoutUser } from "../controllers/authController.js";
router.get("/invite/waiter/validate", validateWaiterToken);

// POST /auth/invite/waiter/setup-password
router.post("/invite/waiter/setup-password", setupWaiterPassword);

// POST /auth/logout
router.post("/logout", logoutUser);

export default router;
