import express from "express";
import {
  getCrmAnalytics,
  getGuests,
  getGuestById,
} from "../controllers/guestProfileController.js";
import { requireEntitlement } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

// Apply CRM entitlement check to all guest profile routes
router.use(requireEntitlement("crm"));

// GET /owner/guests
router.get("/", getGuests);

// Keep this static route before /:guestId so "analytics" is never parsed as an id.
router.get("/analytics", getCrmAnalytics);

// GET /owner/guests/:guestId
router.get("/:guestId", getGuestById);

export default router;
