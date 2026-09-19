import ServicePoint, {
    generateServicePointId,
    normalizeRoomType,
} from "../models/ServicePoint.js"
import crypto from "crypto"
import Business from "../models/Business.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"
import {
    invalidatePublicBusinessForBusinessId,
    invalidatePublicBusinessRoute,
    invalidateSetupProgress,
} from "../services/cacheInvalidationService.js"
import { publishServicePointsChanged } from "../utils/sseManager.js"
import {
    createServicePointQrCapability,
    normalizeServicePointQrCapabilityVersion,
} from "../services/servicePointQrCapabilityService.js"

const PUBLIC_SERVICE_POINT_SOURCE_FIELDS = new Set([
    "label", "servicePointType", "roomType", "capacity", "pricePerNight",
    "currency", "description", "fullDescription", "amenities", "images", "beds",
    "bedType", "bedConfiguration", "viewType", "maxGuests", "isActive", "reservable",
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

function normalizeStringArray(value, field, { maxItems = 50, maxLength = 2048 } = {}) {
    if (!Array.isArray(value)) return { error: `${field} must be an array` }
    if (value.length > maxItems) return { error: `${field} must not contain more than ${maxItems} items` }

    const normalized = []
    const seen = new Set()
    for (const entry of value) {
        if (typeof entry !== "string") return { error: `${field} entries must be strings` }
        const text = entry.trim()
        if (!text) continue
        if (text.length > maxLength) return { error: `${field} entries must not exceed ${maxLength} characters` }
        const key = text.toLowerCase()
        if (!seen.has(key)) {
            seen.add(key)
            normalized.push(text)
        }
    }
    return { value: normalized }
}

function getCreationIdempotencyKey(req) {
    const supplied = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"]
    if (supplied === undefined || supplied === null || supplied === "") return { value: null }
    if (typeof supplied !== "string") return { error: "Idempotency-Key must be a string" }
    const value = supplied.trim()
    if (!value || value.length > 200) return { error: "Idempotency-Key must contain between 1 and 200 characters" }
    return { value }
}

function createRequestFingerprint(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function toPublicServicePoint(servicePoint) {
    const value = typeof servicePoint?.toObject === "function"
        ? servicePoint.toObject()
        : { ...servicePoint }
    delete value.creationIdempotencyKey
    delete value.creationRequestFingerprint
    delete value.qrCapabilityVersion
    return value
}

function findManagedRoomType(business, requestedRoomType) {
    if (requestedRoomType === null) return null
    const requestedKey = requestedRoomType.toLowerCase()
    return business.hotelRoomTypes?.find(
        roomType => roomType.isDefault !== true &&
            normalizeRoomType(roomType.name)?.toLowerCase() === requestedKey
    ) || undefined
}

function resolveManagedRoomType(business, requestedRoomType, currentRoomType = null) {
    if (requestedRoomType === null) return null

    const requestedKey = requestedRoomType.toLowerCase()
    const configured = findManagedRoomType(business, requestedRoomType)
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
        if (req.query.servicePointType) {
            const business = await Business.findOne({ businessId }).lean()
            const servicePointType = business
                ? resolveAllowedServicePointType(business, req.query.servicePointType)
                : null
            if (!servicePointType) {
                return res.status(400).json({ error: "servicePointType is not enabled for this business" })
            }
            filter.servicePointType = servicePointType
        }

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

function qrCapabilityResponse(servicePoint) {
    const version = normalizeServicePointQrCapabilityVersion(
        servicePoint.qrCapabilityVersion
    )
    return {
        capability: createServicePointQrCapability({
            businessId: servicePoint.businessId,
            servicePointId: servicePoint.servicePointId,
            version,
        }),
        version,
    }
}

function handleQrCapabilityControllerError(name, error, res) {
    if (error?.code === "SERVICE_POINT_QR_CAPABILITY_SECRET_MISSING") {
        console.error(`[${name}] QR capability signing is not configured`)
        return res.status(503).json({
            error: "QR generation is temporarily unavailable",
        })
    }
    console.error(`[${name}]`, error)
    return res.status(500).json({ error: "Failed to generate QR capability" })
}

/**
 * GET /owner/service-points/:servicePointId/qr-capability
 * Derive the current signed capability for an authorized management user.
 */
export async function getServicePointQrCapability(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const servicePoint = await ServicePoint.findOne({
            businessId,
            servicePointId: req.params.servicePointId,
        }).select("+qrCapabilityVersion")
        if (!servicePoint) {
            return res.status(404).json({ error: "Service point not found" })
        }

        return res.json(qrCapabilityResponse(servicePoint))
    } catch (error) {
        return handleQrCapabilityControllerError(
            "getServicePointQrCapability",
            error,
            res
        )
    }
}

/**
 * POST /owner/service-points/:servicePointId/qr-capability/rotate
 * Atomically increment canonical QR state. For legacy records with no stored
 * version, the first rotation moves from implicit version 1 to version 2.
 */
export async function rotateServicePointQrCapability(req, res) {
    try {
        const businessId = resolveOwnerBusinessId(req)
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const servicePoint = await ServicePoint.findOneAndUpdate(
            {
                businessId,
                servicePointId: req.params.servicePointId,
            },
            [{
                $set: {
                    qrCapabilityVersion: {
                        $add: [
                            { $ifNull: ["$qrCapabilityVersion", 1] },
                            1,
                        ],
                    },
                },
            }],
            {
                new: true,
                select: "+qrCapabilityVersion",
                updatePipeline: true,
            }
        )
        if (!servicePoint) {
            return res.status(404).json({ error: "Service point not found" })
        }

        return res.json(qrCapabilityResponse(servicePoint))
    } catch (error) {
        return handleQrCapabilityControllerError(
            "rotateServicePointQrCapability",
            error,
            res
        )
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
    let resolvedBusinessId = null
    let resolvedIdempotencyKey = null
    let resolvedRequestFingerprint = null
    try {
        const businessId = resolveOwnerBusinessId(req)
        resolvedBusinessId = businessId
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
            isActive,
            reservable,
            servicePointType: requestedServicePointType,
        } = req.body

        if (typeof label !== "string" || !label.trim()) {
            return res.status(400).json({ error: "label is required" })
        }
        if (label.trim().length > 80) {
            return res.status(400).json({ error: "label must not exceed 80 characters" })
        }

        if (typeof code !== "string" || !code.trim()) {
            return res.status(400).json({ error: "code is required" })
        }
        if (code.trim().length > 20) {
            return res.status(400).json({ error: "code must not exceed 20 characters" })
        }
        if (isActive !== undefined && typeof isActive !== "boolean") {
            return res.status(400).json({ error: "isActive must be a boolean" })
        }
        if (reservable !== undefined && typeof reservable !== "boolean") {
            return res.status(400).json({ error: "reservable must be a boolean" })
        }

        const idempotency = getCreationIdempotencyKey(req)
        if (idempotency.error) return res.status(400).json({ error: idempotency.error })
        resolvedIdempotencyKey = idempotency.value

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
        let managedRoomType = null
        if (servicePointType === "room" && normalizedRoomType !== null) {
            managedRoomType = findManagedRoomType(business, normalizedRoomType)
            if (!managedRoomType || managedRoomType.active === false) {
                return res.status(400).json({
                    error: "roomType must be an active configured hotel room type",
                })
            }
            resolvedRoomType = managedRoomType.name
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
        const parsedAmenities = amenities !== undefined
            ? normalizeStringArray(amenities, "amenities", { maxItems: 50, maxLength: 80 })
            : { value: undefined }
        const parsedImages = images !== undefined
            ? normalizeStringArray(images, "images", { maxItems: 10, maxLength: 2048 })
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
            parsedAmenities,
            parsedImages,
        ].find(result => result.error)?.error
        if (validationError) {
            return res.status(400).json({ error: validationError })
        }

        const inheritedMaxGuests = managedRoomType?.maxGuests ?? undefined
        const finalMaxGuests = parsedMaxGuests.value !== undefined
            ? parsedMaxGuests.value
            : inheritedMaxGuests
        const resolvedCapacity = servicePointType === "room" && finalMaxGuests != null
            ? finalMaxGuests
            : capacity !== undefined && capacity !== null && capacity !== ""
                ? parsedCapacity.value
                : null

        const inheritedBedConfiguration = Array.isArray(managedRoomType?.bedConfiguration)
            ? managedRoomType.bedConfiguration.map(entry => ({
                bedType: entry.bedType,
                count: Number(entry.count),
            }))
            : undefined
        const resolvedBedConfiguration = parsedBedConfiguration.value !== undefined
            ? parsedBedConfiguration.value
            : inheritedBedConfiguration
        const resolvedBeds = resolvedBedConfiguration !== undefined
            ? resolvedBedConfiguration.reduce((sum, entry) => sum + entry.count, 0)
            : parsedBeds.value

        const finalDescription = parsedDescription.value !== undefined
            ? parsedDescription.value
            : managedRoomType?.description || undefined
        const finalViewType = parsedViewType.value !== undefined
            ? parsedViewType.value
            : managedRoomType?.viewType || undefined
        const finalAmenities = parsedAmenities.value !== undefined
            ? parsedAmenities.value
            : Array.from(managedRoomType?.amenities || [])
        const finalImages = parsedImages.value !== undefined
            ? parsedImages.value
            : Array.from(managedRoomType?.images || [])

        const createValues = {
            label: label.trim(),
            code: code.trim(),
            servicePointType,
            roomType: servicePointType === "room" ? resolvedRoomType : null,
            capacity: resolvedCapacity,
            isActive: isActive ?? true,
            reservable: reservable ?? true,
            pricePerNight: parsedPrice.value,
            fullDescription: finalDescription,
            amenities: finalAmenities,
            images: finalImages,
            beds: resolvedBeds,
            bedType: parsedBedType.value,
            bedConfiguration: resolvedBedConfiguration,
            viewType: finalViewType,
            maxGuests: finalMaxGuests,
        }

        resolvedRequestFingerprint = createRequestFingerprint(createValues)
        if (resolvedIdempotencyKey) {
            const existing = await ServicePoint.findOne({
                businessId,
                creationIdempotencyKey: resolvedIdempotencyKey,
            }).select("+creationIdempotencyKey +creationRequestFingerprint")
            if (existing) {
                if (existing.creationRequestFingerprint !== resolvedRequestFingerprint) {
                    return res.status(409).json({ error: "Idempotency-Key was already used for another service point" })
                }
                return res.status(200).json(toPublicServicePoint(existing))
            }
        }

        // Generate a unique stable ID (retry on collision).
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
            ...createValues,
            creationIdempotencyKey: resolvedIdempotencyKey,
            creationRequestFingerprint: resolvedRequestFingerprint,
        })

        await Promise.all([
            invalidateSetupProgress(businessId),
            invalidatePublicBusinessRoute(business.countryCode, business.slug),
        ])
        await publishServicePointsChanged({
            businessId,
            scope: "configuration",
            publish: req.app?.locals?.publishEvent,
        })

        return res.status(201).json(toPublicServicePoint(sp))
    } catch (err) {
        if (
            err?.code === 11000 &&
            resolvedBusinessId &&
            resolvedIdempotencyKey &&
            resolvedRequestFingerprint
        ) {
            const existing = await ServicePoint.findOne({
                businessId: resolvedBusinessId,
                creationIdempotencyKey: resolvedIdempotencyKey,
            }).select("+creationIdempotencyKey +creationRequestFingerprint")
            if (existing?.creationRequestFingerprint === resolvedRequestFingerprint) {
                return res.status(200).json(toPublicServicePoint(existing))
            }
            return res.status(409).json({ error: "Idempotency-Key was already used for another service point" })
        }
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
            isActive,
            reservable,
            servicePointType: requestedServicePointType,
        } = req.body

        const updates = {}
        if (label !== undefined) {
            if (typeof label !== "string" || !label.trim()) return res.status(400).json({ error: "label cannot be empty" })
            if (label.trim().length > 80) return res.status(400).json({ error: "label must not exceed 80 characters" })
            updates.label = label.trim()
        }
        if (code !== undefined) {
            if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "code cannot be empty" })
            if (code.trim().length > 20) return res.status(400).json({ error: "code must not exceed 20 characters" })
            updates.code = code.trim()
        }
        if (isActive !== undefined) {
            if (typeof isActive !== "boolean") return res.status(400).json({ error: "isActive must be a boolean" })
            updates.isActive = isActive
        }
        if (reservable !== undefined) {
            if (typeof reservable !== "boolean") return res.status(400).json({ error: "reservable must be a boolean" })
            updates.reservable = reservable
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
        if (amenities !== undefined) {
            const parsed = normalizeStringArray(amenities, "amenities", { maxItems: 50, maxLength: 80 })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.amenities = parsed.value
        }
        if (images !== undefined) {
            const parsed = normalizeStringArray(images, "images", { maxItems: 10, maxLength: 2048 })
            if (parsed.error) return res.status(400).json({ error: parsed.error })
            updates.images = parsed.value
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
        await publishServicePointsChanged({
            businessId,
            scope: "configuration",
            publish: req.app?.locals?.publishEvent,
        })

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
        await publishServicePointsChanged({
            businessId,
            scope: "configuration",
            publish: req.app?.locals?.publishEvent,
        })

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
        await publishServicePointsChanged({
            businessId,
            scope: "configuration",
            publish: req.app?.locals?.publishEvent,
        })

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
        await publishServicePointsChanged({
            businessId,
            scope: "configuration",
            publish: req.app?.locals?.publishEvent,
        })

        return res.json({ success: true, message: "Service point deleted successfully" })
    } catch (err) {
        console.error("[deleteServicePoint]", err)
        return res.status(500).json({ error: "Failed to delete service point" })
    }
}

