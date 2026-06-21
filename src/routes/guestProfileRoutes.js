import express from "express";
import { getGuests, getGuestById } from "../controllers/guestProfileController.js";

const router = express.Router();

// GET /owner/guests
router.get("/", getGuests);

// GET /owner/guests/:guestId
router.get("/:guestId", getGuestById);

export default router;
