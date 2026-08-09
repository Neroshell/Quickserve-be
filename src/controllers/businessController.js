import Business from "../models/Business.js"
import Order from "../models/order.js"
import Plan from "../models/Plan.js"
import ServicePoint, { normalizeRoomType } from "../models/ServicePoint.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"
import { generateSlugFromName } from "../utils/slugify.js"
import { isCountryResolutionError, validateCountryMetadataPayload } from "../utils/countryHelper.js"
import { hashToken } from "../utils/tokenHash.js"
import { assertEmailAvailable, isEmailAlreadyInUseError, normalizeAccountEmail, sendEmailInUseResponse } from "../utils/emailAvailability.js"
import {
    attachBusinessCapabilities,
    getBusinessModuleCatalog,
    resolveBusinessCapabilities,
    getDefaultBusinessModules,
    resolveBusinessModules,
    setBusinessModuleEnabled,
    validateBusinessModulesForType,
} from "../services/businessCapabilityService.js"

function generateBusinessId() {
    return `biz_${crypto.randomBytes(7).toString("hex")}`
}

// Secret / credential fields that must NEVER be returned by any API response,
// including platform-admin responses. Also used to block them from $set updates.
const SENSITIVE_BUSINESS_FIELDS = [
    "ownerPasswordHash",
    "passwordResetToken",
    "passwordResetExpires",
    "inviteToken",
    "inviteTokenExpires",
]

// Mongoose .select() string that excludes the sensitive fields above.
const SAFE_BUSINESS_PROJECTION = SENSITIVE_BUSINESS_FIELDS.map((f) => `-${f}`).join(" ")

/** Strip secret fields from a Business object (plain or Mongoose doc) before sending it out. */
function sanitizeBusiness(biz) {
    if (!biz) return biz
    const obj = typeof biz.toObject === "function" ? biz.toObject() : { ...biz }
    for (const field of SENSITIVE_BUSINESS_FIELDS) delete obj[field]
    return attachBusinessCapabilities(obj)
}

// Profile/config fields a tenant manager may edit via PATCH /business/settings.
// Deliberately EXCLUDES plan/billing/owner/stripe/status fields so a tenant
// cannot escalate their plan, bypass billing, or hijack ownership.
const ALLOWED_SETTINGS_UPDATE_FIELDS = [
    "name", "displayName", "slug", "address", "phoneNumber", "contactEmail",
    "currency", "timezone", "country", "language", "taxRate", "businessType",
    "logoUrl", "logoPublicId", "platformFeeLabel", "passPlatformFeeToCustomer",
    "menuCategories",
]

function isValidTimeString(value) {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export async function getSettings(req, res) {
    try {
        // businessId is derived from the authenticated session only — never from
        // the request — to prevent cross-tenant reads and secret leakage.
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        const business = await Business.findOne({ businessId }).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        const bizObj = business.toObject()
        const canUseOfflinePayments = bizObj.billingStatus === "active" && !!bizObj.defaultPaymentMethodId
        bizObj.offlinePaymentsAvailable = canUseOfflinePayments
        bizObj.offlinePaymentsUnavailableReason = canUseOfflinePayments 
            ? null 
            : (bizObj.billingStatus === "past_due" ? "past_due" : "billing_not_setup")

        // Resolve platform fee rate from the plan
        const currentPlan = bizObj.currentPlan || "basic";
        bizObj.currentPlan = currentPlan
        const planDef = await Plan.findOne({ slug: currentPlan }).lean()
        const platformFeeRate = planDef ? planDef.offlineCommissionRate : 2.5
        bizObj.platformFeeRate = platformFeeRate

        // Branding Access & Downgrade Protection
        const canUseBranding = ["growth", "pro"].includes(currentPlan)
        const canRemoveQuickServeBranding = currentPlan === "pro"
        
        bizObj.brandingAccess = {
            canUseBranding,
            canRemoveQuickServeBranding
        }
        
        if (!canUseBranding) {
            bizObj.branding = null
        } else if (bizObj.branding) {
            if (!canRemoveQuickServeBranding) {
                bizObj.branding.removeQuickServeBranding = false
            }
        }

        return res.json(attachBusinessCapabilities(bizObj))
    } catch (err) {
        console.error("Get settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}


export async function updateSettings(req, res) {
    try {
        const { settings, hotelSettings } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        // Only allow known, non-privileged profile fields to be updated.
        const updateObj = {}
        for (const field of ALLOWED_SETTINGS_UPDATE_FIELDS) {
            if (req.body[field] !== undefined) updateObj[field] = req.body[field]
        }

        if (updateObj.businessType !== undefined) {
            if (!VALID_BUSINESS_TYPES.includes(updateObj.businessType)) {
                return res.status(400).json({ message: `Invalid businessType. Must be one of: ${VALID_BUSINESS_TYPES.join(", ")}` })
            }

            const existingIdentity = await Business.findOne({ businessId }).select("businessType modules").lean()
            if (!existingIdentity) {
                return res.status(404).json({ message: "Business not found" })
            }

            try {
                const preservedModules = resolveBusinessModules(existingIdentity)
                updateObj.modules = validateBusinessModulesForType(
                    updateObj.businessType,
                    [...preservedModules, ...getDefaultBusinessModules(updateObj.businessType)]
                )
            } catch (err) {
                return res.status(400).json({ message: err.message })
            }
        }

        if (updateObj.country !== undefined) {
            let countryMetadata
            try {
                countryMetadata = validateCountryMetadataPayload(updateObj.country, updateObj)
            } catch (err) {
                if (isCountryResolutionError(err)) {
                    return res.status(400).json({ message: err.message })
                }
                throw err
            }

            const existingBiz = await Business.findOne({ businessId }).select("countryCode").lean()
            if (!existingBiz) {
                return res.status(404).json({ message: "Business not found" })
            }

            if (countryMetadata.countryCode !== existingBiz.countryCode) {
                updateObj.country = countryMetadata.country
                updateObj.countryCode = countryMetadata.countryCode
                updateObj.currency = countryMetadata.currency
                updateObj.timezone = countryMetadata.timezone
            } else {
                delete updateObj.country
            }
        }

        // Handle nested settings if provided (schema-enforced boolean flags only)
        if (settings && typeof settings === 'object') {
            if (
                settings.arrivalReminderEnabled !== undefined &&
                typeof settings.arrivalReminderEnabled !== "boolean"
            ) {
                return res.status(400).json({
                    message: "arrivalReminderEnabled must be a boolean",
                })
            }
            if (settings.arrivalReminderLeadMinutes !== undefined) {
                const leadMinutes = Number(settings.arrivalReminderLeadMinutes)
                if (
                    !Number.isInteger(leadMinutes) ||
                    leadMinutes < 0 ||
                    leadMinutes > 10080
                ) {
                    return res.status(400).json({
                        message: "arrivalReminderLeadMinutes must be a whole number from 0 to 10080",
                    })
                }
                settings.arrivalReminderLeadMinutes = leadMinutes
            }
            for (const [key, value] of Object.entries(settings)) {
                updateObj[`settings.${key}`] = value
            }
        }

        if (hotelSettings && typeof hotelSettings === "object") {
            const { checkInTime, checkOutTime } = hotelSettings

            if (checkInTime !== undefined) {
                if (!isValidTimeString(checkInTime)) {
                    return res.status(400).json({ message: "checkInTime must be in HH:mm format" })
                }
                updateObj["hotelSettings.checkInTime"] = checkInTime
            }

            if (checkOutTime !== undefined) {
                if (!isValidTimeString(checkOutTime)) {
                    return res.status(400).json({ message: "checkOutTime must be in HH:mm format" })
                }
                updateObj["hotelSettings.checkOutTime"] = checkOutTime
            }
        }

        // Slug validation if being updated explicitly
        if (updateObj.slug) {
            const slugRegex = /^[a-z0-9-]+$/
            if (!slugRegex.test(updateObj.slug)) {
                return res.status(400).json({ message: "Slug: lowercase, letters, numbers, hyphens only" })
            }
            if (updateObj.slug.length < 3 || updateObj.slug.length > 40) {
                return res.status(400).json({ message: "Slug must be between 3 and 40 characters" })
            }

            const existingBiz = await Business.findOne({ businessId })
            
            const resolvedCountryCode = updateObj.countryCode || existingBiz?.countryCode || 'mt'

            const existing = await Business.findOne({ 
                slug: updateObj.slug, 
                countryCode: resolvedCountryCode,
                businessId: { $ne: businessId } 
            })
            if (existing) {
                return res.status(400).json({ message: "Slug already in use in this region" })
            }
        } else if (updateObj.displayName || updateObj.name) {
            // Auto-generate slug once if missing or still using the old rest_ format
            const existingBiz = await Business.findOne({ businessId });
            if (existingBiz && (!existingBiz.slug || existingBiz.slug.startsWith('rest_'))) {
                const baseSlug = generateSlugFromName(updateObj.displayName || updateObj.name);
                let newSlug = baseSlug;
                let counter = 1;
                
                const resolvedCountryCode = updateObj.countryCode || existingBiz.countryCode || 'mt'

                while (await Business.exists({ slug: newSlug, countryCode: resolvedCountryCode, businessId: { $ne: businessId } })) {
                    newSlug = `${baseSlug}-${counter}`;
                    counter++;
                }
                updateObj.slug = newSlug;
            }
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: updateObj },
            { new: true, runValidators: true }
        ).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business)
    } catch (err) {
        console.error("Update settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOwnerBusinessModules(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        const { foodServiceEnabled } = req.body
        if (typeof foodServiceEnabled !== "boolean") {
            return res.status(400).json({ message: "foodServiceEnabled must be a boolean" })
        }

        const business = await Business.findOne({ businessId })
            .select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        if (business.businessType !== "hotel") {
            return res.status(400).json({
                message: "Food Service can only be enabled or disabled from owner settings for hotel businesses",
            })
        }

        try {
            business.modules = setBusinessModuleEnabled(
                business,
                "foodService",
                foodServiceEnabled
            )
        } catch (err) {
            return res.status(400).json({ message: err.message })
        }

        await business.save()

        const updatedBusiness = attachBusinessCapabilities(business)
        return res.json({
            modules: updatedBusiness.modules,
            capabilities: updatedBusiness.capabilities,
        })
    } catch (err) {
        console.error("Update owner business modules error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOperatingHours(req, res) {
    try {
        const { operatingHours } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!operatingHours) {
            return res.status(400).json({ message: "operatingHours is required" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: { operatingHours } },
            { new: true, runValidators: true }
        ).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business)
    } catch (err) {
        console.error("Update operating hours error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOrderingPreferences(req, res) {
    try {
        const { orderingPreferences, settings } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!orderingPreferences) {
            return res.status(400).json({ message: "orderingPreferences is required" })
        }

        // Only allow the known boolean fields to be updated
        const { dineInEnabled, takeoutEnabled, callWaiterEnabled, hideOutOfStockItems, qrOrderingEnabled, enableWaiterOrdering } = orderingPreferences
        const safePrefs = {}
        if (typeof dineInEnabled === "boolean") safePrefs["orderingPreferences.dineInEnabled"] = dineInEnabled
        if (typeof takeoutEnabled === "boolean") safePrefs["orderingPreferences.takeoutEnabled"] = takeoutEnabled
        if (typeof callWaiterEnabled === "boolean") safePrefs["orderingPreferences.callWaiterEnabled"] = callWaiterEnabled
        if (typeof hideOutOfStockItems === "boolean") safePrefs["orderingPreferences.hideOutOfStockItems"] = hideOutOfStockItems
        if (typeof qrOrderingEnabled === "boolean") safePrefs["orderingPreferences.qrOrderingEnabled"] = qrOrderingEnabled
        if (typeof enableWaiterOrdering === "boolean") safePrefs["orderingPreferences.enableWaiterOrdering"] = enableWaiterOrdering

        if (settings && typeof settings.reservationsEnabled === "boolean") {
            safePrefs["settings.reservationsEnabled"] = settings.reservationsEnabled
        }
        if (settings && typeof settings.tipsEnabled === "boolean") {
            safePrefs["settings.tipsEnabled"] = settings.tipsEnabled
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ orderingPreferences: business.orderingPreferences })
    } catch (err) {
        console.error("Update ordering preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updatePaymentPreferences(req, res) {
    try {
        const { paymentPreferences } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!paymentPreferences) {
            return res.status(400).json({ message: "paymentPreferences is required" })
        }

        const { acceptOnlinePayments, acceptOfflinePayments, acceptCash, acceptPosCard } = paymentPreferences
        const safePrefs = {}
        if (typeof acceptOnlinePayments === "boolean") safePrefs["paymentPreferences.acceptOnlinePayments"] = acceptOnlinePayments
        if (typeof acceptOfflinePayments === "boolean") safePrefs["paymentPreferences.acceptOfflinePayments"] = acceptOfflinePayments
        if (typeof acceptCash === "boolean") safePrefs["paymentPreferences.acceptCash"] = acceptCash
        if (typeof acceptPosCard === "boolean") safePrefs["paymentPreferences.acceptPosCard"] = acceptPosCard

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ paymentPreferences: business.paymentPreferences })
    } catch (err) {
        console.error("Update payment preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateTablePreferences(req, res) {
    try {
        const { tablePreferences } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!tablePreferences) {
            return res.status(400).json({ message: "tablePreferences is required" })
        }

        const { sessionExpiryMinutes, maxActiveSessionsPerTable } = tablePreferences
        const safePrefs = {}

        if (typeof sessionExpiryMinutes === "number" && sessionExpiryMinutes > 0) {
            safePrefs["tablePreferences.sessionExpiryMinutes"] = sessionExpiryMinutes
        } else if (sessionExpiryMinutes !== undefined) {
             return res.status(400).json({ message: "sessionExpiryMinutes must be a positive number" })
        }
        
        if (typeof maxActiveSessionsPerTable === "number" && maxActiveSessionsPerTable > 0) {
            safePrefs["tablePreferences.maxActiveSessionsPerTable"] = maxActiveSessionsPerTable
        } else if (maxActiveSessionsPerTable !== undefined) {
             return res.status(400).json({ message: "maxActiveSessionsPerTable must be a positive number" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ tablePreferences: business.tablePreferences })
    } catch (err) {
        console.error("Update table preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

const VALID_BUSINESS_TYPES = ["restaurant", "bar_lounge", "hotel"]
const VALID_PLANS = ["basic", "starter", "growth", "pro"]

export async function addHotelRoomType(req, res) {
    try {
        const { name } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        if (!name || typeof name !== "string" || name.trim() === "") {
            return res.status(400).json({ message: "Room type name is required" })
        }

        const normalizedName = normalizeRoomType(name)
        if (normalizedName.length > 80) {
            return res.status(400).json({ message: "Room type name must not exceed 80 characters" })
        }

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        if (resolveBusinessCapabilities(business).identity.shell !== "hotel") {
            return res.status(403).json({ message: "Only hotels can manage room types" })
        }

        if (!business.hotelRoomTypes) {
            business.hotelRoomTypes = []
        }

        // Room-type identity ignores case and repeated whitespace.
        const existingIndex = business.hotelRoomTypes.findIndex(
            rt => normalizeRoomType(rt.name)?.toLowerCase() === normalizedName.toLowerCase()
        )

        if (existingIndex !== -1) {
            const existingRt = business.hotelRoomTypes[existingIndex]
            if (existingRt.active) {
                return res.status(400).json({ message: "A room type with this name already exists" })
            } else {
                // Reactivate previously deactivated room type
                existingRt.active = true
                await business.save()
                return res.status(200).json({ roomType: existingRt })
            }
        }

        const nextSortOrder = business.hotelRoomTypes.length > 0
            ? Math.max(...business.hotelRoomTypes.map(rt => rt.sortOrder || 0)) + 1
            : 1

        const newRoomType = {
            name: normalizedName,
            sortOrder: nextSortOrder,
            active: true,
            isDefault: false
        }

        business.hotelRoomTypes.push(newRoomType)
        await business.save()

        return res.status(201).json({ roomType: business.hotelRoomTypes[business.hotelRoomTypes.length - 1] })
    } catch (err) {
        console.error("Add hotel room type error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function removeHotelRoomType(req, res) {
    try {
        const { name } = req.query
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        if (!name || typeof name !== "string" || name.trim() === "") {
            return res.status(400).json({ message: "Room type name is required" })
        }

        const normalizedName = normalizeRoomType(name)
        if (normalizedName.length > 80) {
            return res.status(400).json({ message: "Room type name must not exceed 80 characters" })
        }

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        if (resolveBusinessCapabilities(business).identity.shell !== "hotel") {
            return res.status(403).json({ message: "Only hotels can manage room types" })
        }

        if (!business.hotelRoomTypes || business.hotelRoomTypes.length === 0) {
            return res.status(404).json({ message: "Room type not found" })
        }

        const existingIndex = business.hotelRoomTypes.findIndex(
            rt => normalizeRoomType(rt.name)?.toLowerCase() === normalizedName.toLowerCase()
        )

        if (existingIndex === -1) {
            return res.status(404).json({ message: "Room type not found" })
        }

        const roomTypeObj = business.hotelRoomTypes[existingIndex]

        // Rule: Default room types cannot be removed
        if (roomTypeObj.isDefault) {
            return res.status(400).json({ message: "Default room types cannot be removed" })
        }

        // Check if any ServicePoint for this business currently uses this roomType
        const regexName = new RegExp(
            `^${normalizedName
                .split(" ")
                .map(part => part.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"))
                .join("\\s+")}$`,
            "i"
        )
        const inUseCount = await ServicePoint.countDocuments({
            businessId,
            roomType: regexName
        })

        if (inUseCount > 0) {
            // Deactivate custom room type
            business.hotelRoomTypes[existingIndex].active = false
            await business.save()
            return res.status(200).json({
                message: `${roomTypeObj.name} is currently used by ${inUseCount} room(s). Removing it will hide it from future room-type selection, but existing rooms will keep their current room type.`,
                deactivated: true,
                inUseCount,
                roomType: business.hotelRoomTypes[existingIndex]
            })
        } else {
            // Hard remove from hotelRoomTypes
            business.hotelRoomTypes.splice(existingIndex, 1)
            await business.save()
            return res.status(200).json({
                message: "Room type removed successfully",
                removed: true
            })
        }
    } catch (err) {
        console.error("Remove hotel room type error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function createBusiness(req, res) {
    try {
        const {
            name,
            displayName,
            slug,
            contactEmail,
            phone,
            address,
            country,
            countryCode,
            currency,
            timezone,
            language,
            settings,
            businessType,
            modules,
            plan,
            planId,
            notes
        } = req.body

        // Simple validation
        if (!name || !displayName || !slug) {
            return res.status(400).json({ message: "Missing required fields (name, displayName, slug)" })
        }

        // businessType validation
        if (businessType && !VALID_BUSINESS_TYPES.includes(businessType)) {
            return res.status(400).json({ message: `Invalid businessType. Must be one of: ${VALID_BUSINESS_TYPES.join(", ")}` })
        }

        const resolvedBusinessType = businessType || "restaurant"
        let resolvedModules
        try {
            resolvedModules = validateBusinessModulesForType(
                resolvedBusinessType,
                modules === undefined ? getDefaultBusinessModules(resolvedBusinessType) : modules
            )
        } catch (err) {
            return res.status(400).json({ message: err.message })
        }

        // plan validation
        if (plan && !VALID_PLANS.includes(plan)) {
            return res.status(400).json({ message: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}` })
        }

        // Slug validation
        const slugRegex = /^[a-z0-9-]+$/
        if (!slugRegex.test(slug)) {
            return res.status(400).json({ message: "Slug: lowercase, letters, numbers, hyphens only" })
        }

        let countryMetadata
        try {
            countryMetadata = validateCountryMetadataPayload(country, { countryCode, currency, timezone })
        } catch (err) {
            if (isCountryResolutionError(err)) {
                return res.status(400).json({ message: err.message })
            }
            throw err
        }

        const existingSlug = await Business.findOne({ slug, countryCode: countryMetadata.countryCode })
        if (existingSlug) {
            return res.status(400).json({ message: "A business with this slug already exists in this region." })
        }

        const businessId = generateBusinessId()

        const business = await Business.create({
            businessId,
            businessId: businessId, // legacy alias stored in DB for existing integrations
            name,
            displayName,
            slug,
            contactEmail,
            phoneNumber: phone,
            address,
            country: countryMetadata.country,
            countryCode: countryMetadata.countryCode,
            currency: countryMetadata.currency,
            timezone: countryMetadata.timezone,
            language: language || "en",
            settings: settings || {
                onlinePaymentEnabled: true,
                offlinePaymentEnabled: true,
                acceptCash: true,
                acceptPOS: true,
                dineInEnabled: true,
                takeoutEnabled: false,
                callWaiterEnabled: true
            },
            businessType: resolvedBusinessType,
            modules: resolvedModules,
            plan,
            planId,
            notes,
            status: "draft"
        })

        return res.status(201).json(sanitizeBusiness(business))
    } catch (err) {
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern || {})[0]
            if (field === "slug") {
                return res.status(400).json({ message: "A business with this slug already exists. Please choose a different slug." })
            }
            return res.status(400).json({ message: "Duplicate entry error" })
        }
        console.error("Create business error:", err)
        return res.status(500).json({ message: "Server error creating business" })
    }
}

export async function createAdminOwner(req, res) {
    try {
        const { ownerName, ownerEmail } = req.body
        const businessId = req.body.businessId || req.body.businessId

        if (!businessId || !ownerName || !ownerEmail) {
            return res.status(400).json({ message: "Missing required fields (businessId, ownerName, ownerEmail)" })
        }

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        if (business.ownerEmail) {
            return res.status(400).json({ message: "This business already has an owner assigned" })
        }

        const normalizedOwnerEmail = normalizeAccountEmail(ownerEmail)
        if (!normalizedOwnerEmail) {
            return res.status(400).json({ message: "A valid owner email is required" })
        }

        try {
            await assertEmailAvailable(normalizedOwnerEmail)
        } catch (err) {
            if (isEmailAlreadyInUseError(err)) {
                return sendEmailInUseResponse(res)
            }
            throw err
        }

        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

        const updatedBusiness = await Business.findOneAndUpdate(
            { businessId },
            {
                $set: {
                    ownerName,
                    ownerEmail: normalizedOwnerEmail,
                    ownerStatus: "pending",
                    inviteToken: hashToken(inviteToken), // store hash; raw token only goes in the email
                    inviteTokenExpires
                }
            },
            { new: true }
        )

        // Send invitation email in background
        const inviteLink = `${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/setup-account?token=${inviteToken}`
        
        sendOnboardingEmail({ to: ownerEmail, userName: ownerName, businessName: updatedBusiness.displayName, inviteLink, role: "owner" }).catch(err => {
            console.error(`[createAdminOwner] Failed to send invitation email to ${ownerEmail}:`, err)
        })

        return res.status(201).json(sanitizeBusiness(updatedBusiness))
    } catch (err) {
        console.error("Create admin owner error:", err)
        return res.status(500).json({ message: "Server error creating owner" })
    }
}

export async function getAdminBusinesses(req, res) {
    try {
        const businesses = await Business.find().select(SAFE_BUSINESS_PROJECTION).populate("planId").lean()

        const enrichedBusinesses = await Promise.all(businesses.map(async (biz) => {
            // Aggregate metrics from orders
            const stats = await Order.aggregate([
                { 
                    $match: { 
                        $or: [{ businessId: biz.businessId }, { businessId: biz.businessId }],
                        paymentStatus: "paid"
                    } 
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                        lastOrderDate: { $max: "$createdAt" },
                        count: { $sum: 1 }
                    }
                }
            ])

            const metrics = stats[0] || { totalSales: 0, lastOrderDate: biz.createdAt, count: 0 }
            
            // Calculate commission based on assigned plan or default to 10%
            const commissionRate = biz.planId?.offlineCommissionRate ?? 0
            const commission = metrics.totalSales * (commissionRate / 100)

            return {
                ...attachBusinessCapabilities(biz),
                owner: {
                    id: biz._id,
                    name: biz.ownerName || "Unknown",
                    email: biz.ownerEmail || "Unknown",
                    status: "active",
                    createdAt: biz.createdAt
                },
                businessMetrics: {
                    totalSales: metrics.totalSales,
                    commission: commission,
                    lastOrderDate: metrics.lastOrderDate
                }
            }
        }))

        return res.json(enrichedBusinesses)
    } catch (err) {
        console.error("Get admin businesses error:", err)
        return res.status(500).json({ message: "Server error fetching businesses" })
    }
}

export async function getAdminOwners(req, res) {
    try {
        const businesses = await Business.find().lean()

        // Each business has one owner (ownerName, ownerEmail)
        const owners = businesses.map(biz => ({
            id: biz._id,
            name: biz.ownerName || "Unknown",
            email: biz.ownerEmail || "Unknown",
            status: "active",
            createdAt: biz.createdAt,
            businessId: biz.businessId,
            businessName: biz.displayName
        }))

        return res.json(owners)
    } catch (err) {
        console.error("Get admin owners error:", err)
        return res.status(500).json({ message: "Server error fetching owners" })
    }
}

export async function getAdminBusinessById(req, res) {
    try {
        const { businessId: paramId } = req.params
        const business = await Business.findOne({ $or: [{ businessId: paramId }, { businessId: paramId }] }).select(SAFE_BUSINESS_PROJECTION).populate("planId").lean()

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        // Aggregate metrics from orders
        const stats = await Order.aggregate([
            { 
                $match: { 
                    $or: [{ businessId: business.businessId }, { businessId: business.businessId }],
                    paymentStatus: "paid"
                } 
            },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                    lastOrderDate: { $max: "$createdAt" },
                    count: { $sum: 1 }
                }
            }
        ])

        const metrics = stats[0] || { totalSales: 0, lastOrderDate: business.createdAt, count: 0 }
        
        // Calculate commission based on assigned plan or default to 10%
        const commissionRate = business.planId?.offlineCommissionRate ?? 0
        const commission = metrics.totalSales * (commissionRate / 100)

        const enrichedBusiness = {
            ...attachBusinessCapabilities(business),
            owner: {
                id: business._id,
                name: business.ownerName || "Unknown",
                email: business.ownerEmail || "Unknown",
                status: "active",
                createdAt: business.createdAt
            },
            businessMetrics: {
                totalSales: metrics.totalSales,
                commission: commission,
                lastOrderDate: metrics.lastOrderDate
            }
        }

        return res.json(enrichedBusiness)
    } catch (err) {
        console.error("Get business by ID error:", err)
        return res.status(500).json({ message: "Server error fetching business" })
    }
}

export async function updateAdminBusiness(req, res) {
    try {
        const { businessId: paramId } = req.params
        const updateData = { ...req.body }

        // Never allow credential/secret fields to be set through the admin API.
        for (const field of SENSITIVE_BUSINESS_FIELDS) delete updateData[field]

        const existingBusinessForUpdate = await Business.findOne({
            $or: [{ businessId: paramId }, { businessId: paramId }]
        }).select("_id businessId businessId businessType modules countryCode").lean()
        if (!existingBusinessForUpdate) {
            return res.status(404).json({ message: "Business not found" })
        }

        const nextBusinessType = updateData.businessType || existingBusinessForUpdate.businessType || "restaurant"
        if (!VALID_BUSINESS_TYPES.includes(nextBusinessType)) {
            return res.status(400).json({ message: `Invalid businessType. Must be one of: ${VALID_BUSINESS_TYPES.join(", ")}` })
        }

        try {
            if (updateData.modules !== undefined) {
                updateData.modules = validateBusinessModulesForType(nextBusinessType, updateData.modules)
            } else if (nextBusinessType !== existingBusinessForUpdate.businessType) {
                const preservedModules = resolveBusinessModules(existingBusinessForUpdate)
                updateData.modules = validateBusinessModulesForType(
                    nextBusinessType,
                    [...preservedModules, ...getDefaultBusinessModules(nextBusinessType)]
                )
            }
        } catch (err) {
            return res.status(400).json({ message: err.message })
        }

        if (updateData.ownerEmail !== undefined) {
            const normalizedOwnerEmail = normalizeAccountEmail(updateData.ownerEmail)
            if (!normalizedOwnerEmail) {
                return res.status(400).json({ message: "A valid owner email is required" })
            }

            try {
                await assertEmailAvailable(normalizedOwnerEmail, {
                    exclude: {
                        businessObjectId: existingBusinessForUpdate._id,
                        businessId: existingBusinessForUpdate.businessId || existingBusinessForUpdate.businessId
                    }
                })
            } catch (err) {
                if (isEmailAlreadyInUseError(err)) {
                    return sendEmailInUseResponse(res)
                }
                throw err
            }

            updateData.ownerEmail = normalizedOwnerEmail
        }

        if (updateData.country !== undefined) {
            let countryMetadata
            try {
                countryMetadata = validateCountryMetadataPayload(updateData.country, updateData)
            } catch (err) {
                if (isCountryResolutionError(err)) {
                    return res.status(400).json({ message: err.message })
                }
                throw err
            }

            if (countryMetadata.countryCode !== existingBusinessForUpdate.countryCode) {
                updateData.country = countryMetadata.country
                updateData.countryCode = countryMetadata.countryCode
                updateData.currency = countryMetadata.currency
                updateData.timezone = countryMetadata.timezone
            } else {
                delete updateData.country
                delete updateData.countryCode
            }
        } else {
            delete updateData.countryCode
        }

        const business = await Business.findOneAndUpdate(
            { $or: [{ businessId: paramId }, { businessId: paramId }] },
            { $set: updateData },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(sanitizeBusiness(business))
    } catch (err) {
        console.error("Update business error:", err)
        return res.status(500).json({ message: "Server error updating business" })
    }
}

export function getAdminBusinessModuleCatalog(req, res) {
    return res.json(getBusinessModuleCatalog())
}

export async function getAdminDashboardStats(req, res) {
    try {
        // 1. Business Status & Plan Distribution
        const [businesses, plans] = await Promise.all([
            Business.find().lean(),
            Plan.find({ isActive: true }).lean()
        ])
        const totalBusinesses = businesses.length
        
        const statsByStatus = {
            active: 0,
            draft: 0,
            suspended: 0,
            archived: 0
        }
        
        // Build dynamic plan stats from db plans
        const statsByPlan = {}
        plans.forEach(p => {
            statsByPlan[p.name.toLowerCase()] = 0
        })
        
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        
        let newBusinesses = 0
        
        businesses.forEach(b => {
            if (statsByStatus.hasOwnProperty(b.status)) statsByStatus[b.status]++
            
            // Increment plan stat
            const planKey = b.plan?.toLowerCase() || "basic"
            if (statsByPlan.hasOwnProperty(planKey)) {
                statsByPlan[planKey]++
            } else if (!statsByPlan[planKey] && plans.length > 0) {
                // Fallback for custom or legacy plan names not in the current active plans list
                if (!statsByPlan["other"]) statsByPlan["other"] = 0
                statsByPlan["other"]++
            }
            
            if (new Date(b.createdAt) > thirtyDaysAgo) newBusinesses++
        })

        // 2. Executive KPIs & Platform Performance
        const orderStats = await Order.aggregate([
            { 
                $facet: {
                    totals: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                                totalTransactions: { $sum: 1 }
                            }
                        }
                    ],
                    orderCount: [
                        { $count: "count" }
                    ],
                    byBusiness: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: "$businessId",
                                revenue: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                                orders: { $sum: 1 }
                            }
                        },
                        { $sort: { revenue: -1 } },
                        { $limit: 10 }
                    ],
                    zeroOrders30d: [
                        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                        { $group: { _id: "$businessId" } }
                    ]
                }
            }
        ])

        const totals = orderStats[0].totals[0] || { totalRevenue: 0, totalTransactions: 0 }
        const totalOrders = orderStats[0].orderCount[0]?.count || 0
        
        // Enrich top businesses with display names
        const topByRevenueData = orderStats[0].byBusiness
        const topBusinessIds = topByRevenueData.map(item => item._id)
        const topBusinessDocs = await Business.find({ businessId: { $in: topBusinessIds } }).lean()
        
        const enrichedTopByRevenue = topByRevenueData.map(item => {
            const doc = topBusinessDocs.find(d => d.businessId === item._id)
            return {
                businessId: item._id,
                displayName: doc?.displayName || "Unknown",
                revenue: item.revenue,
                orders: item.orders,
                status: doc?.status || "active"
            }
        })

        const topByOrders = [...enrichedTopByRevenue].sort((a, b) => b.orders - a.orders).slice(0, 5)
        const topByRevenue = enrichedTopByRevenue.slice(0, 5)

        // Calculate businesses with zero orders in last 30 days
        const activeBusinessIdsWithOrders = new Set(orderStats[0].zeroOrders30d.map(item => item._id))
        const zeroOrders30dCount = businesses.filter(b => 
            b.status === "active" && !activeBusinessIdsWithOrders.has(b.businessId)
        ).length

        const dashboardData = {
            totalRevenue: totals.totalRevenue,
            totalOrders: totalOrders,
            totalTransactions: totals.totalTransactions,
            activeRestaurants: statsByStatus.active,   // kept for admin frontend compat
            newRestaurants: newBusinesses,              // kept for admin frontend compat
            totalRestaurants: totalBusinesses,          // kept for admin frontend compat
            draftRestaurants: statsByStatus.draft,
            suspendedRestaurants: statsByStatus.suspended,
            archivedRestaurants: statsByStatus.archived,
            // Also expose with businessId-canonical names
            activeBusinesses: statsByStatus.active,
            newBusinesses: newBusinesses,
            totalBusinesses: totalBusinesses,
            byPlan: statsByPlan,
            topByRevenue: topByRevenue,
            topByOrders: topByOrders,
            zeroOrders30d: zeroOrders30dCount
        }

        return res.json(dashboardData)
    } catch (err) {
        console.error("Dashboard stats error:", err)
        return res.status(500).json({ message: "Server error fetching dashboard stats" })
    }
}

export async function getCategories(req, res) {
    try {
        const businessId = req.query.businessId || req.query.businessId || req.user?.businessId || req.user?.businessId
        if (!businessId) {
            return res.status(400).json({ message: "businessId is required" })
        }

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        // Return menuCategories array or default if not set
        return res.json(business.menuCategories && business.menuCategories.length > 0 
            ? business.menuCategories 
            : ["appetizers", "mains", "desserts", "beverages"])
    } catch (err) {
        console.error("Get categories error:", err)
        return res.status(500).json({ message: "Server error fetching categories" })
    }
}

export async function addCategory(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        const { category } = req.body

        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!category) {
            return res.status(400).json({ message: "category is required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        if (!trimmedCategory) {
            return res.status(400).json({ message: "Invalid category" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $addToSet: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business.menuCategories)
    } catch (err) {
        console.error("Add category error:", err)
        return res.status(500).json({ message: "Server error adding category" })
    }
}

export async function removeCategory(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        const category = req.query.category || req.body.category

        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!category) {
            return res.status(400).json({ message: "category is required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        const defaultCategories = ["appetizers", "mains", "desserts", "beverages"]

        if (defaultCategories.includes(trimmedCategory)) {
            return res.status(400).json({ message: "Cannot delete default categories" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $pull: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business.menuCategories)
    } catch (err) {
        console.error("Remove category error:", err)
        return res.status(500).json({ message: "Server error removing category" })
    }
}

export async function deleteAdminBusiness(req, res) {
    try {
        const { businessId: paramId } = req.params;

        if (!paramId) {
            return res.status(400).json({ message: "Business ID is required" });
        }

        const deletedBusiness = await Business.findOneAndDelete({ $or: [{ businessId: paramId }, { businessId: paramId }] });

        if (!deletedBusiness) {
            return res.status(404).json({ message: "Business not found" });
        }

        return res.json({ message: "Business successfully deleted", businessId: paramId });
    } catch (err) {
        console.error("Delete business error:", err);
        return res.status(500).json({ message: "Server error deleting business" });
    }
}
