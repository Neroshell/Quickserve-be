import Business from "../models/Business.js"
import {
    PROPERTY_ACCOMMODATION_TYPES,
    PROPERTY_FACILITY_IDS,
    PROPERTY_LANGUAGE_IDS,
} from "../constants/propertyProfileCatalog.js"
import {
    buildPropertyProfileResponse,
    serializePropertyPhoto,
} from "../services/propertyProfileService.js"
import { resolveCountryMetadata } from "../utils/countryHelper.js"
import { normalizeInternationalPhoneNumber } from "../utils/phoneNumber.js"
import { deleteFromCloudinary, uploadToCloudinary } from "../utils/uploadToCloudinary.js"
import {
    invalidateBusinessConfiguration,
    invalidatePublicBusinessRoute,
} from "../services/cacheInvalidationService.js"

const PROPERTY_PROFILE_SELECT = [
    "businessId",
    "businessType",
    "modules",
    "displayName",
    "address",
    "addressPlaceId",
    "latitude",
    "longitude",
    "phoneNumber",
    "contactEmail",
    "country",
    "countryCode",
    "currency",
    "timezone",
    "hotelSettings",
    "propertyProfile",
    "slug",
    "updatedAt",
].join(" ")

const SECTION_IDS = new Set([
    "details",
    "location",
    "photos",
    "facilities",
    "languages",
    "arrival-departure",
    "policies",
    "contact",
])
const ACCOMMODATION_TYPE_IDS = new Set(PROPERTY_ACCOMMODATION_TYPES.map(type => type.id))
const FACILITY_IDS = new Set(PROPERTY_FACILITY_IDS)
const LANGUAGE_IDS = new Set(PROPERTY_LANGUAGE_IDS)
const PETS_POLICIES = new Set(["allowed", "on_request", "not_allowed"])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PROPERTY_PHOTOS = 30

class PropertyProfileValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = "PropertyProfileValidationError"
    }
}

function cleanText(value, { field, maxLength, required = false } = {}) {
    if (value === undefined) return undefined
    if (value === null) value = ""
    if (typeof value !== "string") throw new PropertyProfileValidationError(`${field} must be text`)

    const cleaned = value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]*>/g, "")
        .trim()

    if (required && !cleaned) throw new PropertyProfileValidationError(`${field} is required`)
    if (cleaned.length > maxLength) {
        throw new PropertyProfileValidationError(`${field} must be ${maxLength} characters or fewer`)
    }
    return cleaned
}

function nullableBoolean(value, field) {
    if (value === undefined) return undefined
    if (value === null || typeof value === "boolean") return value
    throw new PropertyProfileValidationError(`${field} must be yes, no, or unanswered`)
}

function nullableEnum(value, allowed, field) {
    if (value === undefined) return undefined
    if (value === null || value === "") return null
    if (typeof value !== "string" || !allowed.has(value)) {
        throw new PropertyProfileValidationError(`Invalid ${field}`)
    }
    return value
}

function uniqueKnownIds(value, allowed, field) {
    if (!Array.isArray(value)) throw new PropertyProfileValidationError(`${field} must be a list`)
    const result = []
    for (const rawId of value) {
        const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : ""
        if (!allowed.has(id)) throw new PropertyProfileValidationError(`Invalid ${field} value: ${String(rawId)}`)
        if (!result.includes(id)) result.push(id)
    }
    return result
}

function cleanWebsiteUrl(value) {
    const cleaned = cleanText(value, { field: "Website", maxLength: 2048 })
    if (!cleaned) return ""
    try {
        const parsed = new URL(cleaned)
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol")
        return parsed.toString()
    } catch {
        throw new PropertyProfileValidationError("Website must be a valid http or https URL")
    }
}

function cleanCoordinate(value, { field, min, max }) {
    if (value === undefined) return undefined
    if (value === null || value === "") return null
    const number = Number(value)
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new PropertyProfileValidationError(`${field} must be between ${min} and ${max}`)
    }
    return number
}

function minutes(time) {
    const [hour, minute] = time.split(":").map(Number)
    return hour * 60 + minute
}

function cleanTime(value, field) {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
        throw new PropertyProfileValidationError(`${field} must be in HH:mm format`)
    }
    return value
}

function setProfileValue(profile, key, value) {
    if (value !== undefined) profile[key] = value
}

function ensureHotelProfile(business) {
    if (!business) return { status: 404, message: "Business not found" }
    if (business.businessType !== "hotel") {
        return { status: 409, message: "Property Profile is available for hotel businesses only" }
    }
    if (!business.propertyProfile) business.propertyProfile = {}
    if (!business.hotelSettings) business.hotelSettings = {}
    return null
}

function applyDetails(business, data) {
    const propertyName = cleanText(data.propertyName, {
        field: "Property name",
        maxLength: 160,
        required: true,
    })
    if (propertyName !== undefined) business.displayName = propertyName

    setProfileValue(
        business.propertyProfile,
        "accommodationType",
        nullableEnum(data.accommodationType, ACCOMMODATION_TYPE_IDS, "accommodation type"),
    )
    setProfileValue(
        business.propertyProfile,
        "description",
        cleanText(data.description, { field: "Description", maxLength: 3000 }),
    )

    if (data.starRating !== undefined) {
        if (data.starRating === null || data.starRating === "") {
            business.propertyProfile.starRating = null
        } else {
            const rating = Number(data.starRating)
            if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
                throw new PropertyProfileValidationError("Star rating must be 1 to 5, or Unrated")
            }
            business.propertyProfile.starRating = rating
        }
    }
}

function applyLocation(business, data) {
    const previousAddress = business.address || ""
    const address = cleanText(data.address, { field: "Address", maxLength: 300 })
    if (address !== undefined) business.address = address
    setProfileValue(business.propertyProfile, "city", cleanText(data.city, { field: "City", maxLength: 120 }))
    setProfileValue(business.propertyProfile, "region", cleanText(data.region, { field: "Region", maxLength: 120 }))
    setProfileValue(business.propertyProfile, "postalCode", cleanText(data.postalCode, { field: "Postal code", maxLength: 32 }))

    if (data.country !== undefined) {
        const country = cleanText(data.country, { field: "Country", maxLength: 120, required: true })
        const metadata = resolveCountryMetadata(country)
        const countryChanged = metadata.countryCode !== business.countryCode
        business.country = metadata.country
        business.countryCode = metadata.countryCode
        if (countryChanged) {
            business.currency = metadata.currency
            business.timezone = metadata.timezone
        }
    }

    const latitude = cleanCoordinate(data.latitude, { field: "Latitude", min: -90, max: 90 })
    const longitude = cleanCoordinate(data.longitude, { field: "Longitude", min: -180, max: 180 })
    if ((latitude === null) !== (longitude === null) || (latitude === undefined) !== (longitude === undefined)) {
        throw new PropertyProfileValidationError("Latitude and longitude must be provided together")
    }
    if (latitude !== undefined) {
        business.latitude = latitude
        business.longitude = longitude
    } else if (address !== undefined && address !== previousAddress) {
        business.latitude = null
        business.longitude = null
        business.addressPlaceId = ""
    }
}

function applyPhotos(business, data) {
    if (!Array.isArray(data.photoIds)) {
        throw new PropertyProfileValidationError("photoIds must be a list")
    }
    if (data.photoIds.length > MAX_PROPERTY_PHOTOS) {
        throw new PropertyProfileValidationError(`A property can have up to ${MAX_PROPERTY_PHOTOS} photos`)
    }

    const currentPhotos = Array.from(business.propertyProfile.photos || [])
    const byId = new Map(currentPhotos.map(photo => [String(photo._id || photo.id), photo]))
    const seen = new Set()
    const nextPhotos = data.photoIds.map(rawId => {
        const id = String(rawId || "")
        if (!id || seen.has(id) || !byId.has(id)) {
            throw new PropertyProfileValidationError("Photos must be unique and belong to this property")
        }
        seen.add(id)
        return byId.get(id)
    })
    const removedPhotos = currentPhotos.filter(photo => !seen.has(String(photo._id || photo.id)))
    business.propertyProfile.photos = nextPhotos
    return removedPhotos
}

function applyFacilities(business, data) {
    if (data.facilityIds !== undefined) {
        business.propertyProfile.facilityIds = uniqueKnownIds(data.facilityIds, FACILITY_IDS, "facility")
    }
    setProfileValue(
        business.propertyProfile,
        "breakfastOffered",
        nullableBoolean(data.breakfastOffered, "Breakfast offered"),
    )

    if (data.parking !== undefined) {
        if (!data.parking || typeof data.parking !== "object" || Array.isArray(data.parking)) {
            throw new PropertyProfileValidationError("Parking must be an object")
        }
        const available = nullableBoolean(data.parking.available, "Parking availability")
        const parking = {
            available: available ?? null,
            cost: nullableEnum(data.parking.cost, new Set(["free", "paid"]), "parking cost"),
            reservation: nullableEnum(data.parking.reservation, new Set(["required", "not_required"]), "parking reservation"),
            location: nullableEnum(data.parking.location, new Set(["onsite", "offsite"]), "parking location"),
            access: nullableEnum(data.parking.access, new Set(["private", "public"]), "parking access"),
        }
        if (parking.available !== true) {
            parking.cost = null
            parking.reservation = null
            parking.location = null
            parking.access = null
        }
        business.propertyProfile.parking = parking
    }
}

function applyLanguages(business, data) {
    business.propertyProfile.languages = uniqueKnownIds(data.languages, LANGUAGE_IDS, "language")
}

function applyArrivalDeparture(business, data) {
    const values = {
        checkInTime: cleanTime(data.checkInFrom, "Check-in from"),
        checkInUntil: cleanTime(data.checkInUntil, "Check-in until"),
        checkOutFrom: cleanTime(data.checkOutFrom, "Check-out from"),
        checkOutTime: cleanTime(data.checkOutUntil, "Check-out until"),
    }
    if (minutes(values.checkInTime) > minutes(values.checkInUntil)) {
        throw new PropertyProfileValidationError("Check-in from must be earlier than check-in until")
    }
    if (minutes(values.checkOutFrom) > minutes(values.checkOutTime)) {
        throw new PropertyProfileValidationError("Check-out from must be earlier than check-out until")
    }
    Object.assign(business.hotelSettings, values)
}

function applyPolicies(business, data) {
    setProfileValue(
        business.propertyProfile,
        "childrenAllowed",
        nullableBoolean(data.childrenAllowed, "Children policy"),
    )
    setProfileValue(
        business.propertyProfile,
        "petsPolicy",
        nullableEnum(data.petsPolicy, PETS_POLICIES, "pets policy"),
    )
}

function applyContact(business, data) {
    if (data.phone !== undefined) {
        const phone = cleanText(data.phone, { field: "Phone", maxLength: 40 })
        if (phone) {
            const normalized = normalizeInternationalPhoneNumber(phone)
            if (!normalized) throw new PropertyProfileValidationError("Enter a complete, valid phone number")
            business.phoneNumber = normalized
        } else {
            business.phoneNumber = ""
        }
    }
    if (data.email !== undefined) {
        const email = cleanText(data.email, { field: "Email", maxLength: 254 }).toLowerCase()
        if (email && !EMAIL_PATTERN.test(email)) {
            throw new PropertyProfileValidationError("Enter a valid guest-facing email address")
        }
        business.contactEmail = email
    }
    if (data.website !== undefined) {
        business.propertyProfile.websiteUrl = cleanWebsiteUrl(data.website)
    }
}

const SECTION_HANDLERS = {
    details: applyDetails,
    location: applyLocation,
    photos: applyPhotos,
    facilities: applyFacilities,
    languages: applyLanguages,
    "arrival-departure": applyArrivalDeparture,
    policies: applyPolicies,
    contact: applyContact,
}

async function invalidatePropertyProfileCaches(business) {
    await Promise.all([
        invalidateBusinessConfiguration(business.businessId),
        invalidatePublicBusinessRoute(business.countryCode, business.slug),
    ])
}

export async function getPropertyProfile(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const business = await Business.findOne({ businessId }).select(PROPERTY_PROFILE_SELECT)
        const domainError = ensureHotelProfile(business)
        if (domainError) return res.status(domainError.status).json({ message: domainError.message })

        return res.json(buildPropertyProfileResponse(business))
    } catch (error) {
        console.error("[property-profile:get]", error)
        return res.status(500).json({ message: "Unable to load Property Profile" })
    }
}

export async function updatePropertyProfileSection(req, res) {
    let removedPhotos = []
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const section = String(req.params?.section || "")
        if (!SECTION_IDS.has(section)) {
            return res.status(404).json({ message: "Unknown Property Profile section" })
        }
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({ message: "Section data is required" })
        }

        const business = await Business.findOne({ businessId }).select(PROPERTY_PROFILE_SELECT)
        const domainError = ensureHotelProfile(business)
        if (domainError) return res.status(domainError.status).json({ message: domainError.message })

        removedPhotos = SECTION_HANDLERS[section](business, req.body) || []
        business.markModified?.("propertyProfile")
        business.markModified?.("hotelSettings")
        await business.save()
        await invalidatePropertyProfileCaches(business)

        const cleanupResults = await Promise.allSettled(
            removedPhotos
                .filter(photo => photo?.publicId)
                .map(photo => deleteFromCloudinary(photo.publicId)),
        )
        for (const result of cleanupResults) {
            if (result.status === "rejected") {
                console.error("[property-profile:photo-cleanup]", result.reason)
            }
        }

        return res.json({
            ...buildPropertyProfileResponse(business),
            savedSection: section,
        })
    } catch (error) {
        if (error instanceof PropertyProfileValidationError || error?.name === "CountryResolutionError") {
            return res.status(400).json({ message: error.message })
        }
        if (error?.name === "ValidationError") {
            return res.status(400).json({ message: error.message })
        }
        console.error("[property-profile:update]", error)
        return res.status(500).json({ message: "Unable to save Property Profile" })
    }
}

export async function uploadPropertyPhoto(req, res) {
    let uploadedPublicId = null
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })
        if (!req.file) return res.status(400).json({ message: "Image file is required" })

        const business = await Business.findOne({ businessId }).select(PROPERTY_PROFILE_SELECT)
        const domainError = ensureHotelProfile(business)
        if (domainError) return res.status(domainError.status).json({ message: domainError.message })
        if ((business.propertyProfile.photos || []).length >= MAX_PROPERTY_PHOTOS) {
            return res.status(400).json({ message: `A property can have up to ${MAX_PROPERTY_PHOTOS} photos` })
        }

        const upload = await uploadToCloudinary(
            req.file.buffer,
            `quickserve/property-profiles/${businessId}`,
            req.file.mimetype,
        )
        uploadedPublicId = upload.public_id
        business.propertyProfile.photos.push({
            url: upload.secure_url,
            publicId: upload.public_id,
        })
        business.markModified?.("propertyProfile")
        await business.save()
        await invalidatePropertyProfileCaches(business)

        const photo = business.propertyProfile.photos[business.propertyProfile.photos.length - 1]
        return res.status(201).json({
            photo: serializePropertyPhoto(photo),
            completeness: buildPropertyProfileResponse(business).completeness,
        })
    } catch (error) {
        if (uploadedPublicId) {
            try {
                await deleteFromCloudinary(uploadedPublicId)
            } catch (cleanupError) {
                console.error("[property-profile:upload-cleanup]", cleanupError)
            }
        }
        console.error("[property-profile:upload]", error)
        return res.status(500).json({ message: "Unable to upload property photo" })
    }
}
