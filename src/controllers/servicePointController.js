import ServicePoint, {
    generateServicePointId,
    normalizeRoomType,
} from "../models/ServicePoint.js"
import Business from "../models/Business.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"
import {
    invalidatePublicBusinessForBusinessId,
    invalidatePublicBusinessRoute,
    invalidateSetupProgress,
} from "../services/cacheInvalidationService.js"

const PUBLIC_SERVICE_POINT_SOURCE_FIELDS = new Set([
    "label", "servicePointType", "roomType", "capacity", "pricePerNight",
    "currency", "description", "fullDescription", "amenities", "images", "beds",
    "bedType", "bedConfiguration", "viewType", "maxGuests",
])

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve businessId from the authenticated owner session.
 * Owner routes NEVER accept businessId from the request body/query —
 * it is always derived from the session to enforce ownership.
 */
function resolveOwnerBusinessId(req) {
    return req.session?.user?.businessId
}

export function resolveAllowedServicePointType(
    business,
    requestedServicePointType
) {
    const capabilities =
        resolveBusinessCapabilities(business).servicePoints
    const servicePointType =
        requestedServicePointType || capabilities.defaultType

    return capabilities.allowedTypes.includes(servicePointType)
        ? servicePointType
        : null
}

function parseNumericField(value, field, { min, integer = false } = {}) {
    if (value === null || value === "") return { value: null }

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        return { error: `${field} must be a valid number` }
    }
    if (integer && !Number.isInteger(parsed)) {
        return { error: `${field} must be a whole number` }
    }
    if (min !== undefined && parsed < min) {
        return { error: `${field} must be at least ${min}` }
    }
    return { value: parsed }
}

function normalizeOptionalText(value, field) {
    if (value === null) return { value: null }
    if (typeof value !== "string") {
        return { error: `${field} must be a string` }
    }
    return { value: value.trim() || null }
}

function normalizeBedConfiguration(value) {
    if (!Array.isArray(value)) {
        return { error: "bedConfiguration must be an array" }
    }

    const seenBedTypes = new Set()
    const normalized = []
    for (const entry of value) {
        if (!entry || typeof entry.bedType !== "string" || !entry.bedType.trim()) {
            return { error: "Each bed configuration entry requires a bedType" }
        }
        const count = Number(entry.count)
        if (!Number.isInteger(count) || count < 1) {
            return { error: "Each bed configuration count must be a positive whole number" }
        }

        const bedType = entry.bedType.trim()
        const bedTypeKey = bedType.toLowerCase()
        if (seenBedTypes.has(bedTypeKey)) {
            return { error: "bedConfiguration cannot contain duplicate bed types" }
        }
        seenBedTypes.add(bedTypeKey)
        normalized.push({ bedType, count })
    }

    return { value: normalized }
}

function resolveManagedRoomType(business, requestedRoomType, currentRoomType = null) {
    if (requestedRoomType === null) return null

    const requestedKey = requestedRoomType.toLowerCase()
    const configured = business.hotelRoomTypes?.find(
        roomType => normalizeRoomType(roomType.name)?.toLowerCase() === requestedKey
    )
    if (configured && configured.active !== false) return configured.name
    if (normalizeRoomType(currentRoomType)?.toLowerCase() === requestedKey) {
        return currentRoomType
    }

    return undefined
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
 * servicePointType is validated against resolved business capabilities.
 *
 * Body: { label, code?, capacity? }
 */
export async function createServicePoint(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const {
            label,
            code,
            capacity,
            pricePerNight,
            description,
            amenities,
            images,
            beds,
            bedType,
            bedConfiguration,
            viewType,
            maxGuests,
            roomType,
            servicePointType: requestedServicePointType,
        } = req.body

        if (typeof label !== "string" || !label.trim()) {
            return res.status(400).json({ error: "label is required" })
        }

        if (typeof code !== "string" || !code.trim()) {
            return res.status(400).json({ error: "code is required" })
        }

        // Fetch the business to validate the requested ServicePoint capability.
        const business = await Business.findOne({ businessId }).lean()
        if (!business) {
            return res.status(404).json({ error: "Business not found" })
        }

        const servicePointType = resolveAllowedServicePointType(
            business,
            requestedServicePointType
        )
        if (!servicePointType) {
            return res.status(400).json({ error: "servicePointType is not enabled for this business" })
        }
        if (roomType !== undefined && roomType !== null && typeof roomType !== "string") {
            return res.status(400).json({ error: "roomType must be a string" })
        }
        const normalizedRoomType = normalizeRoomType(roomType)
        if (
            servicePointType !== "room" &&
            normalizedRoomType !== null
        ) {
            return res.status(400).json({
                error: "roomType is only available for room ServicePoints",
            })
        }
        let resolvedRoomType = null
        if (servicePointType === "room" && normalizedRoomType !== null) {
            resolvedRoomType = resolveManagedRoomType(business, normalizedRoomType)
            if (resolvedRoomType === undefined) {
                return res.status(400).json({
                    error: "roomType must be an active configured hotel room type",
                })
            }
        }

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

        const parsedCapacity = capacity !== undefined
            ? parseNumericField(capacity, "capacity", { min: 1, integer: true })
            : { value: undefined }
        const parsedMaxGuests = maxGuests !== undefined
            ? parseNumericField(maxGuests, "maxGuests", { min: 1, integer: true })
            : { value: undefined }
        const parsedPrice = pricePerNight !== undefined
            ? parseNumericField(pricePerNight, "pricePerNight", { min: 0 })
            : { value: undefined }
        const parsedBeds = beds !== undefined
            ? parseNumericField(beds, "beds", { min: 0, integer: true })
            : { value: undefined }
        const parsedBedConfiguration = bedConfiguration !== undefined
            ? normalizeBedConfiguration(bedConfiguration)
            : { value: undefined }
        const parsedBedType = bedType !== undefined
            ? normalizeOptionalText(bedType, "bedType")
            : { value: undefined }
        const parsedViewType = viewType !== undefined
            ? normalizeOptionalText(viewType, "viewType")
            : { value: undefined }
        const parsedDescription = description !== undefined
            ? normalizeOptionalText(description, "description")
            : { value: undefined }

        const validationError = [
            parsedCapacity,
            parsedMaxGuests,
            parsedPrice,
            parsedBeds,
            parsedBedConfiguration,
            parsedBedType,
            parsedViewType,
            parsedDescription,
        ].find(result => result.error)?.error
        if (validationError) {
            return res.status(400).json({ error: validationError })
        }

        const resolvedCapacity = servicePointType === "room" && parsedMaxGuests.value != null
            ? parsedMaxGuests.value
            : capacity !== undefined && capacity !== null && capacity !== ""
                ? parsedCapacity.value
                : null

        const resolvedBedConfiguration = parsedBedConfiguration.value
        const resolvedBeds = resolvedBedConfiguration !== undefined
            ? resolvedBedConfiguration.reduce((sum, entry) => sum + entry.count, 0)
            : parsedBeds.value

        const sp = await ServicePoint.create({
            servicePointId,
            businessId,
            label: label.trim(),
            code: code?.trim() || "",
            servicePointType,
            roomType: servicePointType === "room" ? resolvedRoomType : null,
            capacity: resolvedCapacity,
            isActive: true,
            pricePerNight: parsedPrice.value,
            fullDescription: parsedDescription.value,
            amenities: Array.isArray(amenities) ? amenities : undefined,
            images: Array.isArray(images) ? images : undefined,
            beds: resolvedBeds,
            bedType: parsedBedType.value,
            bedConfiguration: resolvedBedConfiguration,
            viewType: parsedViewType.value,
            maxGuests: parsedMaxGuests.value,
        })

        await Promise.all([
            invalidateSetupProgress(businessId),
            invalidatePublicBusinessRoute(business.countryCode, business.slug),
        ])

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
        const {
            label,
            code,
            capacity,
            pricePerNight,
            description,
            amenities,
            images,
            beds,
            bedType,
            bedConfiguration,
            viewType,
            maxGuests,
            roomType,
            servicePointType: requestedServicePointType,
        } = req.body

        const updates = {}
        if (label !== undefined) {
            if (typeof label !== "string" || !label.trim()) return res.status(400).json({ error: "label cannot be empty" })
            updates.label = label.trim()
        }
        if (code !== undefined) {
            if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "code cannot be empty" })
            updates.code = code.trim()
        }
        if (capacity !== undefined) {
            const parsed = parseNumericField(capacity, "capacity", { min: 1, integer: true })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.capacity = parsed.value
        }
        if (pricePerNight !== undefined) {
            const parsed = parseNumericField(pricePerNight, "pricePerNight", { min: 0 })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.pricePerNight = parsed.value
        }
        if (description !== undefined) {
            const parsed = normalizeOptionalText(description, "description")
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.fullDescription = parsed.value || ""
        }
        if (amenities !== undefined && Array.isArray(amenities)) {
            updates.amenities = amenities
        }
        if (images !== undefined && Array.isArray(images)) {
            updates.images = images
        }
        if (bedConfiguration !== undefined) {
            const parsed = normalizeBedConfiguration(bedConfiguration)
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.bedConfiguration = parsed.value
            updates.beds = parsed.value.reduce((sum, entry) => sum + entry.count, 0)
        } else if (beds !== undefined) {
            const parsed = parseNumericField(beds, "beds", { min: 0, integer: true })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.beds = parsed.value
        }
        if (bedType !== undefined) {
            const parsed = normalizeOptionalText(bedType, "bedType")
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.bedType = parsed.value
        }
        if (viewType !== undefined) {
            const parsed = normalizeOptionalText(viewType, "viewType")
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.viewType = parsed.value
        }
        if (maxGuests !== undefined) {
            const parsed = parseNumericField(maxGuests, "maxGuests", { min: 1, integer: true })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.maxGuests = parsed.value
            updates.capacity = updates.maxGuests
        }
        let businessForPublicRoute = null
        if (
            requestedServicePointType !== undefined ||
            roomType !== undefined
        ) {
            const current = await ServicePoint.findOne({
                servicePointId,
                businessId,
            }).lean()
            if (!current) {
                return res.status(404).json({
                    error: "Service point not found",
                })
            }

            const business = await Business.findOne({
                businessId,
            }).lean()
            if (!business) {
                return res.status(404).json({
                    error: "Business not found",
                })
            }
            businessForPublicRoute = business

            let finalServicePointType =
                current.servicePointType
            if (requestedServicePointType !== undefined) {
                finalServicePointType =
                    resolveAllowedServicePointType(
                        business,
                        requestedServicePointType
                    )
                if (!finalServicePointType) {
                    return res.status(400).json({
                        error: "servicePointType is not enabled for this business",
                    })
                }
                updates.servicePointType =
                    finalServicePointType
            }

            if (roomType !== undefined) {
                if (roomType !== null && typeof roomType !== "string") {
                    return res.status(400).json({ error: "roomType must be a string" })
                }
                const normalizedRoomType =
                    normalizeRoomType(roomType)
                if (
                    finalServicePointType !== "room" &&
                    normalizedRoomType !== null
                ) {
                    return res.status(400).json({
                        error: "roomType is only available for room ServicePoints",
                    })
                }
                if (finalServicePointType === "room") {
                    const managedRoomType = resolveManagedRoomType(
                        business,
                        normalizedRoomType,
                        current.roomType
                    )
                    if (managedRoomType === undefined) {
                        return res.status(400).json({ error: "roomType must be an active configured hotel room type" })
                    }
                    updates.roomType = managedRoomType
                } else {
                    updates.roomType = null
                }
            } else if (
                requestedServicePointType !== undefined &&
                finalServicePointType !== "room"
            ) {
                updates.roomType = null
            }
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

        const affectsPublicBusiness = Object.keys(updates).some(field =>
            PUBLIC_SERVICE_POINT_SOURCE_FIELDS.has(field)
        )
        await Promise.all([
            invalidateSetupProgress(businessId),
            affectsPublicBusiness
                ? businessForPublicRoute
                    ? invalidatePublicBusinessRoute(
                        businessForPublicRoute.countryCode,
                        businessForPublicRoute.slug,
                    )
                    : invalidatePublicBusinessForBusinessId(businessId)
                : Promise.resolve(true),
        ])

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

        await Promise.all([
            invalidateSetupProgress(businessId),
            invalidatePublicBusinessForBusinessId(businessId),
        ])

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
 * PATCH /owner/service-points/:servicePointId/toggle-reservable
 * Flip reservable between true/false.
 * Ownership is enforced.
 */
export async function toggleReservableServicePoint(req, res) {
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

        current.reservable = !current.reservable
        await current.save()

        await Promise.all([
            invalidateSetupProgress(businessId),
            invalidatePublicBusinessForBusinessId(businessId),
        ])

        return res.json({
            servicePointId: current.servicePointId,
            reservable: current.reservable,
            label: current.label,
        })
    } catch (err) {
        console.error("[toggleReservableServicePoint]", err)
        return res.status(500).json({ error: "Failed to toggle reservable status" })
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

        await Promise.all([
            invalidateSetupProgress(businessId),
            invalidatePublicBusinessForBusinessId(businessId),
        ])

        return res.json({ success: true, message: "Service point deleted successfully" })
    } catch (err) {
        console.error("[deleteServicePoint]", err)
        return res.status(500).json({ error: "Failed to delete service point" })
    }
}

