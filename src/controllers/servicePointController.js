import ServicePoint, {
    generateServicePointId,
    deriveServicePointType,
} from "../models/ServicePoint.js"
import Business from "../models/Business.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve businessId from the authenticated owner session.
 * Owner routes NEVER accept businessId from the request body/query —
 * it is always derived from the session to enforce ownership.
 */
function resolveOwnerBusinessId(req) {
    return req.session?.user?.businessId
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /owner/service-points
 * List all service points for the authenticated owner's business.
 * Optional query: ?active=true → only active points
 */
export async function listServicePoints(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const filter = { businessId }
        if (req.query.active === "true") filter.isActive = true
        if (req.query.active === "false") filter.isActive = false

        const servicePoints = await ServicePoint.find(filter)
            .sort({ createdAt: -1 })
            .lean()

        return res.json(servicePoints)
    } catch (err) {
        console.error("[listServicePoints]", err)
        return res.status(500).json({ error: "Failed to fetch service points" })
    }
}

/**
 * GET /owner/service-points/:servicePointId
 * Fetch a single service point — must belong to the owner's business.
 */
export async function getServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { servicePointId } = req.params

        const sp = await ServicePoint.findOne({ servicePointId, businessId }).lean()
        if (!sp) {
            return res.status(404).json({ error: "Service point not found" })
        }

        return res.json(sp)
    } catch (err) {
        console.error("[getServicePoint]", err)
        return res.status(500).json({ error: "Failed to fetch service point" })
    }
}

/**
 * POST /owner/service-points
 * Create a new service point.
 * businessId is derived from session only.
 * servicePointType is auto-derived from the business's businessType.
 *
 * Body: { label, code?, capacity? }
 */
export async function createServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { label, code, capacity } = req.body

        if (!label || !label.trim()) {
            return res.status(400).json({ error: "label is required" })
        }

        if (!code || !code.trim()) {
            return res.status(400).json({ error: "code is required" })
        }

        // Fetch business to derive servicePointType
        const business = await Business.findOne({ businessId }).lean()
        if (!business) {
            return res.status(404).json({ error: "Business not found" })
        }

        const servicePointType = deriveServicePointType(business.businessType)

        // Generate a unique stable ID (retry on collision)
        let servicePointId
        for (let i = 0; i < 10; i++) {
            const candidate = generateServicePointId()
            const exists = await ServicePoint.findOne({ servicePointId: candidate })
            if (!exists) {
                servicePointId = candidate
                break
            }
        }
        if (!servicePointId) {
            return res.status(500).json({ error: "Failed to generate service point ID" })
        }

        const sp = await ServicePoint.create({
            servicePointId,
            businessId,
            label: label.trim(),
            code: code?.trim() || "",
            servicePointType,
            capacity: capacity ? Number(capacity) : null,
            isActive: true,
        })

        return res.status(201).json(sp)
    } catch (err) {
        console.error("[createServicePoint]", err)
        return res.status(500).json({ error: "Failed to create service point" })
    }
}

/**
 * PATCH /owner/service-points/:servicePointId
 * Update label, code, or capacity of an existing service point.
 * Ownership is enforced — cannot update another business's service point.
 *
 * Body: { label?, code?, capacity? }
 */
export async function updateServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { servicePointId } = req.params
        const { label, code, capacity } = req.body

        const updates = {}
        if (label !== undefined) {
            if (!label.trim()) return res.status(400).json({ error: "label cannot be empty" })
            updates.label = label.trim()
        }
        if (code !== undefined) {
            if (!code.trim()) return res.status(400).json({ error: "code cannot be empty" })
            updates.code = code.trim()
        }
        if (capacity !== undefined) {
            updates.capacity = capacity === null || capacity === "" ? null : Number(capacity)
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No valid fields to update" })
        }

        const sp = await ServicePoint.findOneAndUpdate(
            { servicePointId, businessId },
            { $set: updates },
            { new: true, runValidators: true }
        )

        if (!sp) {
            return res.status(404).json({ error: "Service point not found" })
        }

        return res.json(sp)
    } catch (err) {
        console.error("[updateServicePoint]", err)
        return res.status(500).json({ error: "Failed to update service point" })
    }
}

/**
 * PATCH /owner/service-points/:servicePointId/toggle
 * Flip isActive between true/false.
 * Ownership is enforced.
 */
export async function toggleServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { servicePointId } = req.params

        // Find first to read current state
        const current = await ServicePoint.findOne({ servicePointId, businessId })
        if (!current) {
            return res.status(404).json({ error: "Service point not found" })
        }

        current.isActive = !current.isActive
        await current.save()

        return res.json({
            servicePointId: current.servicePointId,
            isActive: current.isActive,
            label: current.label,
        })
    } catch (err) {
        console.error("[toggleServicePoint]", err)
        return res.status(500).json({ error: "Failed to toggle service point" })
    }
}

/**
 * DELETE /owner/service-points/:servicePointId
 * Delete a service point.
 * Ownership is enforced.
 */
export async function deleteServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { servicePointId } = req.params

        const sp = await ServicePoint.findOneAndDelete({ servicePointId, businessId })
        if (!sp) {
            return res.status(404).json({ error: "Service point not found" })
        }

        return res.json({ success: true, message: "Service point deleted successfully" })
    } catch (err) {
        console.error("[deleteServicePoint]", err)
        return res.status(500).json({ error: "Failed to delete service point" })
    }
}

