import Staff from "../models/Staff.js"
import Business from "../models/Business.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"
import { hashToken } from "../utils/tokenHash.js"
import { assertEmailAvailable, isEmailAlreadyInUseError, normalizeAccountEmail, sendEmailInUseResponse } from "../utils/emailAvailability.js"
import { invalidateSetupProgress } from "../services/cacheInvalidationService.js"
import {
    getEffectiveManagementAreas,
    normalizeCoOwnerRestrictions,
} from "../constants/managementAccess.js"

function resolveBusinessId(req) {
    return req.session?.user?.businessId
}

function buildCoOwnerAccessPayload(coOwner) {
    const coOwnerRestrictions = Array.isArray(coOwner.coOwnerRestrictions)
        ? coOwner.coOwnerRestrictions
        : []

    return {
        staffId: coOwner.staffId,
        role: coOwner.role,
        name: coOwner.name,
        email: coOwner.email,
        accountStatus: coOwner.accountStatus,
        businessId: coOwner.businessId,
        coOwnerRestrictions,
        managementAccessAreas: getEffectiveManagementAreas({
            role: "co_owner",
            coOwnerRestrictions,
        }),
        createdAt: coOwner.createdAt,
        updatedAt: coOwner.updatedAt,
    }
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
                email: business.ownerEmail,
                role: "owner"
            } : null,
            coOwners: coOwners.map(buildCoOwnerAccessPayload)
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

        email = normalizeAccountEmail(email)
        if (!email) {
            return res.status(400).json({ error: "A valid email is required" })
        }

        try {
            await assertEmailAvailable(email)
        } catch (err) {
            if (isEmailAlreadyInUseError(err)) {
                return sendEmailInUseResponse(res)
            }
            throw err
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

        await invalidateSetupProgress(businessId)

        const frontendUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
        const inviteLink = `${frontendUrl}/staff/setup-account?token=${inviteToken}`

        sendOnboardingEmail({ to: coOwner.email, userName: coOwner.name, inviteLink, role: "co_owner" }).catch((err) => {
            console.error("[inviteCoOwner] Email failed:", err)
        })

        return res.status(201).json(buildCoOwnerAccessPayload(coOwner))
    } catch (err) {
        console.error("[inviteCoOwner]", err)
        return res.status(500).json({ error: "Failed to invite co-owner" })
    }
}

export async function getCoOwnerAccess(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { staffId } = req.params
        if (!businessId) return res.status(401).json({ error: "Unauthorized" })

        const coOwner = await Staff.findOne({ businessId, staffId, role: "co_owner" })
            .select("staffId role name email accountStatus businessId coOwnerRestrictions createdAt updatedAt")
        if (!coOwner) return res.status(404).json({ error: "Co-Owner not found" })

        return res.json(buildCoOwnerAccessPayload(coOwner))
    } catch (err) {
        console.error("[getCoOwnerAccess]", err)
        return res.status(500).json({ error: "Failed to fetch co-owner access" })
    }
}

export async function updateCoOwnerAccess(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { staffId } = req.params
        if (!businessId) return res.status(401).json({ error: "Unauthorized" })

        let coOwnerRestrictions
        try {
            coOwnerRestrictions = normalizeCoOwnerRestrictions(req.body?.coOwnerRestrictions)
        } catch (err) {
            return res.status(400).json({ error: err.message })
        }

        const coOwner = await Staff.findOneAndUpdate(
            { businessId, staffId, role: "co_owner" },
            { $set: { coOwnerRestrictions } },
            { new: true, runValidators: true },
        ).select("staffId role name email accountStatus businessId coOwnerRestrictions createdAt updatedAt")

        if (!coOwner) return res.status(404).json({ error: "Co-Owner not found" })

        try {
            const { publishManagementAccessRevocation } = await import("../utils/sseManager.js")
            await publishManagementAccessRevocation({
                businessId,
                staffObjectId: coOwner._id,
                staffId: coOwner.staffId,
            })
        } catch (streamError) {
            console.error("[updateCoOwnerAccess] Failed to refresh Co-Owner live streams", streamError)
        }

        return res.json(buildCoOwnerAccessPayload(coOwner))
    } catch (err) {
        console.error("[updateCoOwnerAccess]", err)
        return res.status(500).json({ error: "Failed to update co-owner access" })
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

        await invalidateSetupProgress(businessId)

        return res.json({ message: "Co-Owner removed successfully" })
    } catch (err) {
        console.error("[removeCoOwner]", err)
        return res.status(500).json({ error: "Failed to remove co-owner" })
    }
}
