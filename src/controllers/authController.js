import Restaurant from "../models/Restaurant.js";
import Waiter from "../models/Waiter.js";
import bcrypt from "bcrypt";

/**
 * Validate an invitation token
 * GET /auth/invite/validate?token=...
 */
export async function validateInviteToken(req, res) {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({ message: "Token is required" });
        }

        const restaurant = await Restaurant.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            ownerStatus: "pending"
        });

        if (!restaurant) {
            return res.status(404).json({ 
                valid: false, 
                message: "Invitation link is invalid, expired, or has already been used." 
            });
        }

        return res.json({ 
            valid: true, 
            ownerName: restaurant.ownerName,
            ownerEmail: restaurant.ownerEmail,
            restaurantName: restaurant.displayName,
            type: "owner"
        });
    } catch (err) {
        console.error("Validate token error:", err);
        return res.status(500).json({ message: "Server error validating token" });
    }
}

/**
 * Validate a waiter invitation token
 * GET /auth/invite/waiter/validate?token=...
 */
export async function validateWaiterToken(req, res) {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({ message: "Token is required" });
        }

        const waiter = await Waiter.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            accountStatus: "pending"
        });

        if (!waiter) {
            return res.status(404).json({ 
                valid: false, 
                message: "Invitation link is invalid, expired, or has already been used." 
            });
        }

        return res.json({ 
            valid: true, 
            name: waiter.name,
            email: waiter.email,
            type: "waitstaff"
        });
    } catch (err) {
        console.error("Validate waiter token error:", err);
        return res.status(500).json({ message: "Server error validating token" });
    }
}

/**
 * Set owner password using token
 * POST /auth/invite/setup-password
 */
export async function setupOwnerPassword(req, res) {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ message: "Token and password are required" });
        }

        const restaurant = await Restaurant.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            ownerStatus: "pending"
        });

        if (!restaurant) {
            return res.status(404).json({ message: "Invalid or expired invitation token" });
        }

        // Hash password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Update restaurant/owner account
        restaurant.ownerPasswordHash = passwordHash;
        restaurant.ownerStatus = "active";
        restaurant.inviteToken = null;
        restaurant.inviteTokenExpires = null;
        
        // Also mark restaurant status as active if it was draft? 
        // User said: "mark owner account as active", "after setting password, owner account should become active"
        // Let's stick to ownerStatus first.
        
        await restaurant.save();

        return res.json({ message: "Password setup successful! You can now log in." });
    } catch (err) {
        console.error("Setup password error:", err);
        return res.status(500).json({ message: "Server error setting up password" });
    }
}

/**
 * Set waiter password using token
 * POST /auth/invite/waiter/setup-password
 */
export async function setupWaiterPassword(req, res) {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ message: "Token and password are required" });
        }

        const waiter = await Waiter.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            accountStatus: "pending"
        });

        if (!waiter) {
            return res.status(404).json({ message: "Invalid or expired invitation token" });
        }

        // Hash password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Update waiter account
        waiter.passwordHash = passwordHash;
        waiter.accountStatus = "active";
        waiter.inviteToken = null;
        waiter.inviteTokenExpires = null;
        
        await waiter.save();

        return res.json({ message: "Account setup successful! You can now log in." });
    } catch (err) {
        console.error("Setup waiter password error:", err);
        return res.status(500).json({ message: "Server error setting up password" });
    }
}

/**
 * Unified login for both owners and waitstaff
 * POST /auth/login
 */
export async function loginUser(req, res) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        // 1. Try finding an Owner (Restaurant)
        const restaurant = await Restaurant.findOne({ ownerEmail: email });
        if (restaurant) {
            if (restaurant.ownerStatus !== "active") {
                return res.status(401).json({ message: "Account is not active. Please check your email for the setup link." });
            }

            const isMatch = await bcrypt.compare(password, restaurant.ownerPasswordHash);
            if (!isMatch) {
                return res.status(401).json({ message: "Invalid credentials" });
            }

            return res.json({
                message: "Login successful",
                type: "owner",
                restaurantId: restaurant.restaurantId,
                ownerName: restaurant.ownerName,
                ownerEmail: restaurant.ownerEmail,
                displayName: restaurant.displayName
            });
        }

        // 2. Try finding a Waitstaff (Waiter)
        const waiter = await Waiter.findOne({ email: email });
        if (waiter) {
            if (waiter.accountStatus !== "active") {
                return res.status(401).json({ message: "Account is not active. Please complete your setup first." });
            }

            const isMatch = await bcrypt.compare(password, waiter.passwordHash);
            if (!isMatch) {
                return res.status(401).json({ message: "Invalid credentials" });
            }

            // Update Presence Status to Active
            waiter.presenceStatus = "active";
            waiter.status = "active"; // sync old status field
            await waiter.save();

            return res.json({
                message: "Login successful",
                type: "waiter",
                waiterId: waiter.waiterId,
                name: waiter.name,
                email: waiter.email,
                restaurantId: waiter.restaurantId
            });
        }

        return res.status(401).json({ message: "Invalid credentials" });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ message: "Server error during login" });
    }
}

/**
 * Logout and set presence to offline for waitstaff
 * POST /auth/logout
 */
export async function logoutUser(req, res) {
    try {
        const { email, type } = req.body; // In a real app, this would come from JWT session

        if (type === "waiter" && email) {
            const waiter = await Waiter.findOne({ email });
            if (waiter) {
                waiter.presenceStatus = "offline";
                waiter.status = "offline"; // sync
                await waiter.save();
            }
        }

        return res.json({ message: "Logged out successfully" });
    } catch (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ message: "Server error during logout" });
    }
}
