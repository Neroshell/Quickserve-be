import Restaurant from "../models/Restaurant.js";
import Staff from "../models/Staff.js";
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
 * Validate a staff invitation token (waiter / kitchen / manager)
 * GET /auth/invite/staff/validate?token=...
 */
export async function validateStaffToken(req, res) {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({ message: "Token is required" });
        }

        const staff = await Staff.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            accountStatus: "pending"
        });

        if (!staff) {
            return res.status(404).json({ 
                valid: false, 
                message: "Invitation link is invalid, expired, or has already been used." 
            });
        }

        return res.json({ 
            valid: true, 
            staffId: staff.staffId,
            waiterId: staff.waiterId, // backward compat
            name: staff.name,
            email: staff.email,
            role: staff.role || "waiter",
            type: "staff"
        });
    } catch (err) {
        console.error("Validate staff token error:", err);
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
        
        await restaurant.save();

        return res.json({ message: "Password setup successful! You can now log in." });
    } catch (err) {
        console.error("Setup password error:", err);
        return res.status(500).json({ message: "Server error setting up password" });
    }
}

/**
 * Set staff password using token
 * POST /auth/invite/staff/setup-password
 */
export async function setupStaffPassword(req, res) {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ message: "Token and password are required" });
        }

        const staff = await Staff.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            accountStatus: "pending"
        });

        if (!staff) {
            return res.status(404).json({ message: "Invalid or expired invitation token" });
        }

        // Hash password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Update staff account
        staff.passwordHash = passwordHash;
        staff.accountStatus = "active";
        staff.inviteToken = null;
        staff.inviteTokenExpires = null;
        
        await staff.save();

        return res.json({ message: "Account setup successful! You can now log in." });
    } catch (err) {
        console.error("Setup staff password error:", err);
        return res.status(500).json({ message: "Server error setting up password" });
    }
}

/**
 * Unified login for both owners and staff
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

        // 2. Try finding a Staff member (Waiter / Kitchen / Manager)
        const staff = await Staff.findOne({ email: email });
        if (staff) {
            if (staff.accountStatus !== "active") {
                return res.status(401).json({ message: "Account is not active. Please complete your setup first." });
            }

            const isMatch = await bcrypt.compare(password, staff.passwordHash);
            if (!isMatch) {
                return res.status(401).json({ message: "Invalid credentials" });
            }

            // Update Presence Status to Active on login
            staff.presenceStatus = "active";
            staff.status = "active"; // sync legacy field
            await staff.save();

            return res.json({
                message: "Login successful",
                // New unified fields
                type: "staff",
                staffId: staff.staffId,
                role: staff.role || "waitstaff",
                // Legacy backward compat fields
                waiterId: staff.waiterId,
                name: staff.name,
                email: staff.email,
                restaurantId: staff.restaurantId
            });
        }

        return res.status(401).json({ message: "Invalid credentials" });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ message: "Server error during login" });
    }
}

/**
 * Logout and set presence to offline for all staff types
 * POST /auth/logout
 */
export async function logoutUser(req, res) {
    try {
        const { email, type } = req.body; // In a real app, this would come from JWT session

        // Handle both legacy type=="waiter" and new type=="staff"
        if ((type === "waiter" || type === "staff") && email) {
            const staff = await Staff.findOne({ email });
            if (staff) {
                staff.presenceStatus = "offline";
                staff.status = "offline"; // sync legacy field
                await staff.save();
            }
        }

        return res.json({ message: "Logged out successfully" });
    } catch (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ message: "Server error during logout" });
    }
}
