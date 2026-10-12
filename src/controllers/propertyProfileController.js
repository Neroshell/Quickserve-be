import Business from "../models/Business.js"
import {
    PROPERTY_ACCOMMODATION_TYPES,
    PROPERTY_FACILITY_IDS,
    PROPERTY_LANGUAGE_IDS,
} from "../constants/propertyProfileCatalog.js"
import {
    CUISINE_TYPE_IDS,
    MEAL_SERVICE_IDS,
    ATMOSPHERE_TAG_IDS,
    DINING_STYLE_IDS,
    DRESS_CODE_IDS,
    DIETARY_OPTION_IDS,
    BAR_HIGHLIGHT_IDS,
    ACCESSIBILITY_FEATURE_IDS,
    RESTAURANT_FACILITY_IDS,
    RESERVATION_POLICY_IDS,
} from "../constants/businessProfileCatalog.js"
import {
    buildPropertyProfileResponse,
    serializePropertyPhoto,
} from "../services/propertyProfileService.js"
import { resolveCountryMetadata } from "../utils/countryHelper.js"
import { normalizeInternationalPhoneNumber } from "../utils/phoneNumber.js"
import { PlacesServiceError, resolveGooglePlace, searchGooglePlaces } from "../services/googlePlacesService.js"
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
    "cuisine",
    "atmosphere",
    "dietary-accessibility",
])
const ACCOMMODATION_TYPE_IDS = new Set(PROPERTY_ACCOMMODATION_TYPES.map(type => type.id))
const ALL_FACILITY_IDS = new Set([...PROPERTY_FACILITY_IDS, ...RESTAURANT_FACILITY_IDS])
const LANGUAGE_IDS = new Set(PROPERTY_LANGUAGE_IDS)
const PETS_POLICIES = new Set(["allowed", "on_request", "not_allowed"])
const CUISINE_IDS = new Set(CUISINE_TYPE_IDS)
const MEAL_IDS = new Set(MEAL_SERVICE_IDS)
const ATMOSPHERE_IDS = new Set(ATMOSPHERE_TAG_IDS)
const DINING_IDS = new Set(DINING_STYLE_IDS)
const DRESS_IDS = new Set(DRESS_CODE_IDS)
const DIETARY_IDS = new Set(DIETARY_OPTION_IDS)
const BAR_IDS = new Set(BAR_HIGHLIGHT_IDS)
const ACCESSIBILITY_IDS = new Set(ACCESSIBILITY_FEATURE_IDS)
const RESERVATION_IDS = new Set(RESERVATION_POLICY_IDS)

const SUPPORTED_PROFILE_SHELLS = new Set(["hotel", "restaurant", "bar_lounge"])
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

/**
 * Shell-aware profile resolver. Supports hotel, restaurant, and bar_lounge.
 * Never silently classifies an unknown business type.
 */
function resolveProfileShell(business) {
    if (!business) return { status: 404, message: "Business not found" }
    if (!SUPPORTED_PROFILE_SHELLS.has(business.businessType)) {
        return { status: 409, message: `Business Profile is not available for business type: ${business.businessType}` }
    }
    if (!business.propertyProfile) business.propertyProfile = {}
    if (business.businessType === "hotel" && !business.hotelSettings) business.hotelSettings = {}
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
        "description",
        cleanText(data.description, { field: "Description", maxLength: 3000 }),
    )

    // --- Hotel-specific detail fields ---
    if (business.businessType === "hotel") {
        setProfileValue(
            business.propertyProfile,
            "accommodationType",
            nullableEnum(data.accommodationType, ACCOMMODATION_TYPE_IDS, "accommodation type"),
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

    // --- Restaurant / Bar detail fields ---
    if (business.businessType !== "hotel") {
        setProfileValue(
            business.propertyProfile,
            "tagline",
            cleanText(data.tagline, { field: "Tagline", maxLength: 120 }),
        )
        if (data.priceLevel !== undefined) {
            if (data.priceLevel === null || data.priceLevel === "") {
                business.propertyProfile.priceLevel = null
            } else {
                const level = Number(data.priceLevel)
                if (![1, 2, 3, 4].includes(level)) {
                    throw new PropertyProfileValidationError("Price level must be 1 to 4")
                }
                business.propertyProfile.priceLevel = level
            }
        }
        setProfileValue(
            business.propertyProfile,
            "diningStyle",
            nullableEnum(data.diningStyle, DINING_IDS, "dining style"),
        )
    }
}

async function applyLocation(business, data) {
    const addressPlaceId = typeof data.addressPlaceId === "string" ? data.addressPlaceId.trim() : ""
    const addressSessionToken = typeof data.addressSessionToken === "string" ? data.addressSessionToken.trim() : ""
    if (!addressPlaceId || !addressSessionToken) {
        throw new PropertyProfileValidationError("Select a valid address from Google Maps before saving")
    }

    const countryCode = cleanText(data.countryCode, { field: "Country", maxLength: 2, required: true })
    const countryMetadata = resolveCountryMetadata(countryCode)
    const selectedAddress = await resolveGooglePlace({
        placeId: addressPlaceId,
        countryCode: countryMetadata.countryCode,
        sessionToken: addressSessionToken,
    })
    const countryChanged = countryMetadata.countryCode !== business.countryCode

    business.address = selectedAddress.address
    business.addressPlaceId = selectedAddress.addressPlaceId
    business.latitude = selectedAddress.latitude
    business.longitude = selectedAddress.longitude
    business.country = countryMetadata.country
    business.countryCode = countryMetadata.countryCode
    business.propertyProfile.city = selectedAddress.city
    business.propertyProfile.region = selectedAddress.region
    business.propertyProfile.postalCode = selectedAddress.postalCode
    if (countryChanged) {
        business.currency = countryMetadata.currency
        business.timezone = countryMetadata.timezone
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
        business.propertyProfile.facilityIds = uniqueKnownIds(data.facilityIds, ALL_FACILITY_IDS, "facility")
    }

    // Hotel-only: breakfast offered
    if (business.businessType === "hotel") {
        setProfileValue(
            business.propertyProfile,
            "breakfastOffered",
            nullableBoolean(data.breakfastOffered, "Breakfast offered"),
        )
    }

    // Restaurant/Bar: bar highlights
    if (business.businessType !== "hotel" && data.barHighlights !== undefined) {
        business.propertyProfile.barHighlights = uniqueKnownIds(data.barHighlights, BAR_IDS, "bar highlight")
    }

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
    // Restaurant/Bar: reservation advisory policy
    if (business.businessType !== "hotel") {
        setProfileValue(
            business.propertyProfile,
            "reservationPolicy",
            nullableEnum(data.reservationPolicy, RESERVATION_IDS, "reservation policy"),
        )
    }
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
    // Social links (restaurant/bar profiles)
    if (data.socialLinks !== undefined && typeof data.socialLinks === "object" && !Array.isArray(data.socialLinks)) {
        const socialLinks = {}
        if (data.socialLinks.instagram !== undefined) {
            socialLinks.instagram = cleanText(data.socialLinks.instagram, { field: "Instagram", maxLength: 100 })
        }
        if (data.socialLinks.facebook !== undefined) {
            socialLinks.facebook = cleanText(data.socialLinks.facebook, { field: "Facebook", maxLength: 255 })
        }
        if (!business.propertyProfile.socialLinks) business.propertyProfile.socialLinks = {}
        Object.assign(business.propertyProfile.socialLinks, socialLinks)
    }
}

// --- New F&B-specific section handlers ---

function applyCuisine(business, data) {
    if (business.businessType === "hotel") {
        throw new PropertyProfileValidationError("Cuisine section is not available for hotels")
    }
    if (data.cuisineTypes !== undefined) {
        business.propertyProfile.cuisineTypes = uniqueKnownIds(data.cuisineTypes, CUISINE_IDS, "cuisine type")
    }
    if (data.mealServices !== undefined) {
        business.propertyProfile.mealServices = uniqueKnownIds(data.mealServices, MEAL_IDS, "meal service")
    }
}

function applyAtmosphere(business, data) {
    if (business.businessType === "hotel") {
        throw new PropertyProfileValidationError("Atmosphere section is not available for hotels")
    }
    if (data.atmosphere !== undefined) {
        business.propertyProfile.atmosphere = uniqueKnownIds(data.atmosphere, ATMOSPHERE_IDS, "atmosphere tag")
    }
    setProfileValue(
        business.propertyProfile,
        "dressCode",
        nullableEnum(data.dressCode, DRESS_IDS, "dress code"),
    )
}

function applyDietaryAccessibility(business, data) {
    if (business.businessType === "hotel") {
        throw new PropertyProfileValidationError("Dietary & Accessibility section is not available for hotels")
    }
    if (data.dietaryOptions !== undefined) {
        business.propertyProfile.dietaryOptions = uniqueKnownIds(data.dietaryOptions, DIETARY_IDS, "dietary option")
    }
    if (data.accessibility !== undefined) {
        business.propertyProfile.accessibility = uniqueKnownIds(data.accessibility, ACCESSIBILITY_IDS, "accessibility feature")
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
    cuisine: applyCuisine,
    atmosphere: applyAtmosphere,
    "dietary-accessibility": applyDietaryAccessibility,
}

async function invalidatePropertyProfileCaches(business) {
    await Promise.all([
        invalidateBusinessConfiguration(business.businessId),
        invalidatePublicBusinessRoute(business.countryCode, business.slug),
    ])
}

export async function getPropertyProfileAddressSuggestions(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const business = await Business.findOne({ businessId }).select("businessId businessType")
        const domainError = resolveProfileShell(business)
        if (domainError) return res.status(domainError.status).json({ message: domainError.message })

        const suggestions = await searchGooglePlaces({
            input: req.query?.input,
            countryCode: req.query?.countryCode,
            sessionToken: req.query?.sessionToken,
        })
        return res.json({ suggestions })
    } catch (error) {
        if (error instanceof PlacesServiceError) {
            return res.status(error.status).json({ message: error.message })
        }
        console.error("[property-profile:address-suggestions]", error)
        return res.status(502).json({ message: "Address search is temporarily unavailable" })
    }
}
export async function getPropertyProfile(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const business = await Business.findOne({ businessId }).select(PROPERTY_PROFILE_SELECT)
        const domainError = resolveProfileShell(business)
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
        const domainError = resolveProfileShell(business)
        if (domainError) return res.status(domainError.status).json({ message: domainError.message })

        removedPhotos = await SECTION_HANDLERS[section](business, req.body) || []
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
        if (error instanceof PropertyProfileValidationError || error instanceof PlacesServiceError || error?.name === "CountryResolutionError") {
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
        const domainError = resolveProfileShell(business)
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
