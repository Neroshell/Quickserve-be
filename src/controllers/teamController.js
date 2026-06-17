import Staff from "../models/Staff.js"
import Business from "../models/Business.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"
import { hashToken } from "../utils/tokenHash.js"

function resolveBusinessId(req) {
    return req.session?.user?.businessId || req.query.businessId
}

export async function getTeam(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        // Fetch Primary Owner
        const business = await Business.findOne({ businessId }).select("-passwordHash -stripeAccountId -platformFeeSettings")
        
        // Fetch Co-Owners
        const coOwners = await Staff.find({ businessId, role: "co_owner" }, {
            __v: 0,
            passwordHash: 0,
            inviteToken: 0,
            inviteTokenExpires: 0
        }).sort({ createdAt: -1 })

        return res.json({
            owner: business ? {
                id: business._id,
                name: business.ownerName,
                email: business.email,
                role: "owner"
            } : null,
            coOwners: coOwners.map(c => ({
                staffId: c.staffId,
                role: c.role,
                name: c.name,
                email: c.email,
                accountStatus: c.accountStatus,
                businessId: c.businessId,
                createdAt: c.createdAt
            }))
        })
    } catch (err) {
        console.error("[getTeam]", err)
        return res.status(500).json({ error: "Failed to fetch team" })
    }
}

export async function inviteCoOwner(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        let { name, email } = req.body

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        if (!name || !email) {
            return res.status(400).json({ error: "name and email are required" })
        }

        email = email.toLowerCase().trim()

        const existingStaff = await Staff.findOne({ businessId, email })
        if (existingStaff) {
            return res.status(409).json({
                message: "A staff member or co-owner with this email already exists in your business."
            })
        }

        const staffId = `COW-${Math.floor(1000 + Math.random() * 9000)}`

        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000)

        const coOwner = await Staff.create({
            businessId,
            staffId,
            role: "co_owner",
            name,
            email,
            accountStatus: "pending",
            presenceStatus: "offline",
            status: "offline",
            inviteToken: hashToken(inviteToken), // store hash; raw token only goes in the email
            inviteTokenExpires
        })

        const frontendUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
        const inviteLink = `${frontendUrl}/staff/setup-account?token=${inviteToken}`

        sendOnboardingEmail({ to: coOwner.email, userName: coOwner.name, inviteLink, role: "co_owner" }).catch((err) => {
            console.error("[inviteCoOwner] Email failed:", err)
        })

        return res.status(201).json({
            staffId: coOwner.staffId,
            role: coOwner.role,
            name: coOwner.name,
            email: coOwner.email,
            accountStatus: coOwner.accountStatus,
            businessId: coOwner.businessId,
            createdAt: coOwner.createdAt
        })
    } catch (err) {
        console.error("[inviteCoOwner]", err)
        return res.status(500).json({ error: "Failed to invite co-owner" })
    }
}

export async function removeCoOwner(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { staffId } = req.params

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        const result = await Staff.findOneAndDelete({ businessId, staffId, role: "co_owner" })

        if (!result) {
            return res.status(404).json({ error: "Co-Owner not found" })
        }

        return res.json({ message: "Co-Owner removed successfully" })
    } catch (err) {
        console.error("[removeCoOwner]", err)
        return res.status(500).json({ error: "Failed to remove co-owner" })
    }
}
