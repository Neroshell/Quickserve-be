import Business from "../models/Business.js";
import Staff from "../models/Staff.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { sendPasswordResetEmail } from "../utils/emailService.js";

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

        const business = await Business.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            ownerStatus: "pending"
        });

        if (!business) {
            return res.status(404).json({ 
                valid: false, 
                message: "Invitation link is invalid, expired, or has already been used." 
            });
        }

        return res.json({ 
            valid: true, 
            ownerName: business.ownerName,
            ownerEmail: business.ownerEmail,
            businessName: business.displayName,
            restaurantName: business.displayName, // legacy alias
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

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ message: "Password must be at least 8 characters long, and contain at least one uppercase letter, one lowercase letter, and one number." });
        }

        const business = await Business.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            ownerStatus: "pending"
        });

        if (!business) {
            return res.status(404).json({ message: "Invalid or expired invitation token" });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        business.ownerPasswordHash = passwordHash;
        business.ownerStatus = "active";
        business.inviteToken = null;
        business.inviteTokenExpires = null;
        
        await business.save();

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

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ message: "Password must be at least 8 characters long, and contain at least one uppercase letter, one lowercase letter, and one number." });
        }

        const staff = await Staff.findOne({
            inviteToken: token,
            inviteTokenExpires: { $gt: new Date() },
            accountStatus: "pending"
        });

        if (!staff) {
            return res.status(404).json({ message: "Invalid or expired invitation token" });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

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

        // 1. Try finding an Owner (Business)
        const business = await Business.findOne({ ownerEmail: email });
        if (business) {
            if (business.ownerStatus !== "active") {
                return res.status(401).json({ message: "Account is not active. Please check your email for the setup link." });
            }

            const isMatch = await bcrypt.compare(password, business.ownerPasswordHash);
            if (!isMatch) {
                return res.status(401).json({ message: "Invalid credentials" });
            }

            const userObj = {
                userId: business._id.toString(),
                email: business.ownerEmail,
                role: "owner",
                businessId: business.businessId || business.restaurantId
            };

            return new Promise((resolve, reject) => {
                req.session.regenerate((err) => {
                    if (err) {
                        console.error("[login] Session regenerate error:", err.message);
                        return reject(err);
                    }
                    req.session.user = userObj;
                    req.session.save((err) => {
                        if (err) {
                            console.error("[login] Session save error:", err.message);
                            return reject(err);
                        }
                        resolve(res.json({
                            message: "Login successful",
                            type: "owner",
                            businessId: business.businessId || business.restaurantId,
                            restaurantId: business.businessId || business.restaurantId,
                            ownerName: business.ownerName,
                            ownerEmail: business.ownerEmail,
                            displayName: business.displayName
                        }));
                    });
                });
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

            const userObj = {
                staffId: staff.staffId,
                email: staff.email,
                role: staff.role || "waiter",
                businessId: staff.businessId || staff.restaurantId
            };

            return new Promise((resolve, reject) => {
                req.session.regenerate((err) => {
                    if (err) return reject(err);
                    req.session.user = userObj;
                    req.session.save((err) => {
                        if (err) return reject(err);
                        resolve(res.json({
                            message: "Login successful",
                            type: "staff",
                            staffId: staff.staffId,
                            role: staff.role || "waitstaff",
                            businessId: staff.businessId || staff.restaurantId,
                            restaurantId: staff.businessId || staff.restaurantId,
                            waiterId: staff.waiterId,
                            name: staff.name,
                            email: staff.email
                        }));
                    });
                });
            });
        }

        return res.status(401).json({ message: "Invalid credentials" });
    } catch (err) {
        console.error("Login Error Details:", err);
        return res.status(500).json({ message: "Server error during login" });
    }
}

/**
 * Logout and set presence to offline for all staff types
 * POST /auth/logout
 */
export async function logoutUser(req, res) {
    try {
        // Mark staff as offline if applicable
        const sessionUser = req.session?.user;
        if (sessionUser && (sessionUser.role === "waiter" || sessionUser.role === "staff" || sessionUser.role === "kitchen") && sessionUser.email) {
            try {
                const staff = await Staff.findOne({ email: sessionUser.email });
                if (staff) {
                    staff.presenceStatus = "offline";
                    staff.status = "offline";
                    await staff.save();
                }
            } catch (dbErr) {
                console.error("Logout: failed to set presence offline:", dbErr.message);
                // Non-fatal — continue with session destruction
            }
        }

        // Destroy session — always clear the cookie even if this fails
        try {
            await new Promise((resolve, reject) => {
                req.session.destroy((err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        } catch (destroyErr) {
            console.error("Logout: session.destroy error (non-fatal):", destroyErr.message);
        }

        res.clearCookie("qs_dashboard_session");
        return res.json({ message: "Logged out successfully" });
    } catch (err) {
        console.error("Logout error:", err);
        // Still attempt to clear cookie and return success to the client
        res.clearCookie("qs_dashboard_session");
        return res.json({ message: "Logged out" });
    }
}

export async function getMe(req, res) {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ message: "Not authenticated" });
        }
        
        const { role, email } = req.session.user;

        // Optionally, grab fresh data from DB to ensure user isn't disabled
        if (role === 'owner' || role === 'admin') {
            const business = await Business.findOne({ ownerEmail: email, ownerStatus: "active" }).select('-ownerPasswordHash');
            if (!business) return res.status(401).json({ message: "Account disabled or not found." });
            return res.json({ 
                ...req.session.user, 
                displayName: business.displayName, 
                name: business.ownerName,
                businessType: business.businessType || "restaurant"
            });
        } else {
            const staff = await Staff.findOne({ email, accountStatus: "active" }).select('-passwordHash');
            if (!staff) return res.status(401).json({ message: "Account disabled or not found." });
            
            // Also fetch business to get businessType
            const business = await Business.findOne({ 
                $or: [
                    { businessId: staff.businessId },
                    { restaurantId: staff.businessId }
                ]
            }).select('businessType').lean();

            return res.json({ 
                ...req.session.user, 
                name: staff.name, 
                waiterId: staff.waiterId,
                businessType: business?.businessType || "restaurant"
            });
        }
    } catch (err) {
        console.error("GetMe error:", err);
        return res.status(500).json({ message: "Server error retrieving session state" });
    }
}

/**
 * Request a password reset email
 * POST /auth/forgot-password
 */
export async function requestPasswordReset(req, res) {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const normalizedEmail = email.trim().toLowerCase();
        
        // Find user by email (Owner first)
        let user = await Business.findOne({ ownerEmail: normalizedEmail });
        let userType = "owner";
        let userName = user ? user.ownerName : null;

        // If not owner, try Staff
        if (!user) {
            user = await Staff.findOne({ email: normalizedEmail });
            userType = "staff";
            userName = user ? user.name : null;
        }

        // Always return success immediately to prevent email enumeration attacks
        res.json({ message: "If an account exists, a reset link has been sent." });

        if (!user) return; // Stop processing, but client already got success response

        // Generate token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Save token to correct model
        if (userType === "owner") {
            user.passwordResetToken = resetToken;
            user.passwordResetExpires = resetTokenExpires;
            await user.save();
        } else {
            user.passwordResetToken = resetToken;
            user.passwordResetExpires = resetTokenExpires;
            await user.save();
        }

        // Send Email
        const resetLink = `${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
        await sendPasswordResetEmail(normalizedEmail, userName, resetLink);

    } catch (err) {
        console.error("Forgot password error:", err);
        // Do not fail the client request for security and UX purposes if we've already responded
        if (!res.headersSent) {
            return res.status(500).json({ message: "Server error processing request" });
        }
    }
}

/**
 * Reset password using token
 * POST /auth/reset-password
 */
export async function resetPassword(req, res) {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ message: "Token and new password are required" });
        }

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ message: "Password must be at least 8 characters long, and contain at least one uppercase letter, one lowercase letter, and one number." });
        }

        // Try to find the user with the valid token
        let user = await Business.findOne({
            passwordResetToken: token,
            passwordResetExpires: { $gt: new Date() }
        });
        let userType = "owner";

        if (!user) {
            user = await Staff.findOne({
                passwordResetToken: token,
                passwordResetExpires: { $gt: new Date() }
            });
            userType = "staff";
        }

        if (!user) {
            return res.status(400).json({ message: "Token is invalid or has expired." });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        if (userType === "owner") {
            user.ownerPasswordHash = passwordHash;
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            await user.save();
        } else {
            user.passwordHash = passwordHash;
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            await user.save();
        }

        return res.json({ message: "Password has been successfully reset. You can now log in." });

    } catch (err) {
        console.error("Reset password error:", err);
        return res.status(500).json({ message: "Server error resetting password" });
    }
}
