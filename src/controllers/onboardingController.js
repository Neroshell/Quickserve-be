import crypto from 'crypto'
import bcrypt from 'bcrypt'
import Business from '../models/Business.js'
import OnboardingSession from '../models/OnboardingSession.js'
import Plan from '../models/Plan.js'
import { hashToken } from '../utils/tokenHash.js'
import { sendOnboardingVerificationCode } from '../utils/emailService.js'
import { isCountryResolutionError, resolveCountryMetadata, validateCountryMetadataPayload } from '../utils/countryHelper.js'
import { assertEmailAvailable, isEmailAlreadyInUseError, sendEmailInUseResponse } from '../utils/emailAvailability.js'
import { getDefaultBusinessModules } from '../services/businessCapabilityService.js'
import { establishOwnerSession } from './authController.js'
import { normalizeInternationalPhoneNumber } from '../utils/phoneNumber.js'
import { PlacesServiceError, resolveGooglePlace, searchGooglePlaces } from '../services/googlePlacesService.js'
import { validateNewPassword } from '../utils/passwordPolicy.js'

const VERIFICATION_CODE_TTL_MS = 30 * 60 * 1000
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000
const VERIFICATION_MAX_ATTEMPTS = 5
const GENERIC_RESEND_MESSAGE = "If an eligible signup exists, a verification code has been sent."

function generateBusinessId() {
    return `biz_${crypto.randomBytes(7).toString("hex")}`
}

function generateSessionId() {
    return `sess_${crypto.randomBytes(16).toString("hex")}`
}

function generateVerificationCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0")
}

function getVerificationExpiresAt() {
    return new Date(Date.now() + VERIFICATION_CODE_TTL_MS)
}

function hasRequiredText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function getMissingBusinessFields(data) {
    const requiredFields = [
        ["name", "business name"],
        ["slug", "business URL"],
        ["country", "country"],
        ["address", "business address"],
        ["phoneNumber", "phone number"],
        ["contactEmail", "business email"]
    ]

    return requiredFields
        .filter(([field]) => !hasRequiredText(data?.[field]))
        .map(([field, label]) => ({ field, label }))
}

export async function replaceVerificationChallenge(normalizedEmail, {
    now = new Date(),
    sendVerificationCode = sendOnboardingVerificationCode,
} = {}) {
    const verificationCode = generateVerificationCode()
    const session = await OnboardingSession.findOneAndUpdate(
        {
            ownerEmail: normalizedEmail,
            emailVerified: false,
            $or: [
                { verificationLastSentAt: { $lte: new Date(now.getTime() - VERIFICATION_RESEND_COOLDOWN_MS) } },
                { verificationLastSentAt: { $exists: false } },
            ],
        },
        {
            $set: {
                verificationToken: hashToken(verificationCode),
                verificationTokenExpires: new Date(now.getTime() + VERIFICATION_CODE_TTL_MS),
                verificationAttempts: 0,
                verificationLastSentAt: now,
                currentStep: 'verify_email',
            },
            $unset: {
                verificationLockedAt: "",
                verificationConsumedAt: "",
            },
            $inc: { verificationGeneration: 1 },
        },
        { new: true },
    )

    if (!session) return { replaced: false, emailSent: false }

    const emailSent = await sendVerificationCode({
        to: normalizedEmail,
        userName: session.ownerName,
        verificationCode,
    })
    return { replaced: true, emailSent: Boolean(emailSent) }
}

export async function getAddressSuggestions(req, res) {
    try {
        const { sessionId } = req.params
        const hasVerifiedSession = await OnboardingSession.exists({ sessionId, emailVerified: true })
        if (!hasVerifiedSession) {
            return res.status(404).json({ message: "Onboarding session not found" })
        }

        const { input, countryCode, sessionToken } = req.query
        const suggestions = await searchGooglePlaces({ input, countryCode, sessionToken })
        return res.json({ suggestions })
    } catch (err) {
        if (err instanceof PlacesServiceError) {
            return res.status(err.status).json({ message: err.message })
        }
        console.error("Address suggestions error:", err)
        return res.status(502).json({ message: "Address search is temporarily unavailable" })
    }
}

/**
 * Step 1: Start Signup (Create Account)
 */
export async function startSignup(req, res) {
    try {
        const { firstName, lastName, email, password, termsAccepted } = req.body

        if (!hasRequiredText(firstName) || !hasRequiredText(lastName) || !hasRequiredText(email) || !hasRequiredText(password)) {
            return res.status(400).json({ message: "All fields are required" })
        }
        if (!termsAccepted) {
            return res.status(400).json({ message: "You must accept the terms and conditions" })
        }

        const passwordValidation = validateNewPassword(password)
        if (!passwordValidation.valid) {
            return res.status(400).json({
                message: passwordValidation.message,
                code: passwordValidation.code,
            })
        }

        const normalizedEmail = email.trim().toLowerCase()

        try {
            const existingSession = await OnboardingSession.findOne({ ownerEmail: normalizedEmail })
                .select("_id sessionId")
                .lean()
            await assertEmailAvailable(normalizedEmail, {
                exclude: existingSession ? {
                    onboardingSessionObjectId: existingSession._id,
                    onboardingSessionId: existingSession.sessionId,
                } : {},
            })
        } catch (err) {
            if (isEmailAlreadyInUseError(err)) {
                return sendEmailInUseResponse(res)
            }
            throw err
        }

        // Generate tokens and hash password
        const saltRounds = 10
        const passwordHash = await bcrypt.hash(password, saltRounds)
        const verificationCode = generateVerificationCode()
        const verificationTokenExpires = getVerificationExpiresAt()

        const ownerName = `${firstName.trim()} ${lastName.trim()}`

        // Upsert session (if they retry signup before verification)
        const session = await OnboardingSession.findOneAndUpdate(
            { ownerEmail: normalizedEmail },
            {
                $set: {
                    sessionId: generateSessionId(),
                    ownerName,
                    passwordHash,
                    passwordPolicyVersion: 1,
                    emailVerified: false,
                    verificationToken: hashToken(verificationCode),
                    verificationTokenExpires,
                    verificationAttempts: 0,
                    verificationLastSentAt: new Date(),
                    verificationGeneration: 1,
                    currentStep: 'verify_email',
                    businessData: {}
                },
                $unset: {
                    verificationLockedAt: "",
                    verificationConsumedAt: ""
                }
            },
            { new: true, upsert: true }
        )

        const emailSent = await sendOnboardingVerificationCode({ 
            to: normalizedEmail, 
            userName: ownerName, 
            verificationCode
        })

        if (!emailSent) {
            return res.status(502).json({ message: "Account created, but we could not send the verification code. Please try resending it." })
        }

        return res.status(201).json({ 
            message: "Account created. Please check your email for the verification code.",
            sessionId: session.sessionId
        })
    } catch (err) {
        console.error("Start signup error:", err)
        return res.status(500).json({ message: "Server error during signup" })
    }
}

/**
 * Resend Email Verification Code
 */
export async function resendVerificationEmail(req, res) {
    try {
        const { email } = req.body
        if (typeof email !== "string" || !email.trim()) {
            return res.status(400).json({ message: "Email is required" })
        }

        const normalizedEmail = email.trim().toLowerCase()
        const result = await replaceVerificationChallenge(normalizedEmail)
        if (result.replaced && !result.emailSent) {
            console.error("Resend verification email delivery failed for an eligible onboarding session")
        }

        return res.status(202).json({ message: GENERIC_RESEND_MESSAGE })
    } catch (err) {
        console.error("Resend verification email error:", err)
        return res.status(500).json({ message: "Server error resending verification code" })
    }
}

/**
 * Step 2: Verify Email
 */
export async function verifyEmail(req, res) {
    try {
        const { email, token } = req.body
        if (typeof email !== "string" || !email.trim() || typeof token !== "string" || !/^\d{6}$/.test(token)) {
            return res.status(400).json({ message: "Email and token are required" })
        }

        const normalizedEmail = email.trim().toLowerCase()
        const hashedToken = hashToken(token)

        const now = new Date()
        const attemptsAvailable = {
            $or: [
                { verificationAttempts: { $lt: VERIFICATION_MAX_ATTEMPTS } },
                { verificationAttempts: { $exists: false } },
            ],
        }
        const session = await OnboardingSession.findOneAndUpdate({
            ownerEmail: normalizedEmail,
            emailVerified: false,
            verificationToken: hashedToken,
            verificationTokenExpires: { $gt: now },
            ...attemptsAvailable,
        }, {
            $set: {
                emailVerified: true,
                verificationConsumedAt: now,
                currentStep: 'business_identity',
            },
            $unset: {
                verificationToken: "",
                verificationTokenExpires: "",
                verificationLockedAt: "",
            },
        }, { new: true })

        if (session) {
            return res.json({
                message: "Email verified successfully",
                sessionId: session.sessionId
            })
        }

        const failedAttempt = await OnboardingSession.findOneAndUpdate({
            ownerEmail: normalizedEmail,
            emailVerified: false,
            verificationTokenExpires: { $gt: now },
            verificationToken: { $ne: hashedToken },
            ...attemptsAvailable,
        }, [
            {
                $set: {
                    verificationAttempts: {
                        $add: [{ $ifNull: ["$verificationAttempts", 0] }, 1],
                    },
                },
            },
            {
                $set: {
                    verificationLockedAt: {
                        $cond: [
                            { $gte: ["$verificationAttempts", VERIFICATION_MAX_ATTEMPTS] },
                            "$$NOW",
                            "$verificationLockedAt",
                        ],
                    },
                },
            },
        ], { new: true })

        if (Number(failedAttempt?.verificationAttempts) >= VERIFICATION_MAX_ATTEMPTS) {
            return res.status(400).json({
                message: "Too many incorrect codes. Request a new verification code.",
                code: "VERIFICATION_ATTEMPTS_EXHAUSTED",
            })
        }

        const challenge = failedAttempt || await OnboardingSession.findOne({ ownerEmail: normalizedEmail })
        if (
            challenge &&
            !challenge.emailVerified &&
            challenge.verificationTokenExpires &&
            challenge.verificationTokenExpires <= now
        ) {
            return res.status(400).json({
                message: "This verification code has expired. Request a new code.",
                code: "VERIFICATION_CODE_EXPIRED",
            })
        }
        if (Number(challenge?.verificationAttempts) >= VERIFICATION_MAX_ATTEMPTS) {
            return res.status(400).json({
                message: "Too many incorrect codes. Request a new verification code.",
                code: "VERIFICATION_ATTEMPTS_EXHAUSTED",
            })
        }

        return res.status(400).json({
            message: "Invalid or expired verification code.",
            code: "INVALID_VERIFICATION_CODE",
        })
    } catch (err) {
        console.error("Verify email error:", err)
        return res.status(500).json({ message: "Server error during verification" })
    }
}

/**
 * Get Session Data
 */
export async function getSession(req, res) {
    try {
        const { sessionId } = req.params
        const session = await OnboardingSession.findOne({ sessionId })
        
        if (!session) {
            return res.status(404).json({ message: "Session not found" })
        }

        return res.json({
            currentStep: session.currentStep,
            emailVerified: session.emailVerified,
            ownerEmail: session.ownerEmail,
            ownerName: session.ownerName,
            businessData: session.businessData
        })
    } catch (err) {
        console.error("Get session error:", err)
        return res.status(500).json({ message: "Server error fetching session" })
    }
}

/**
 * Update Session Data (Steps 4-7)
 */
export async function updateSession(req, res) {
    try {
        const { sessionId } = req.params
        const { currentStep, businessData } = req.body

        const session = await OnboardingSession.findOne({ sessionId })
        if (!session) {
            return res.status(404).json({ message: "Session not found" })
        }

        // Update fields
        if (currentStep) {
            session.currentStep = currentStep
        }
        
        let normalizedBusinessData = businessData
        if (businessData && Object.prototype.hasOwnProperty.call(businessData, "phoneNumber")) {
            const phoneNumber = normalizeInternationalPhoneNumber(businessData.phoneNumber)
            if (!phoneNumber) {
                return res.status(400).json({ message: "Enter a complete, valid phone number" })
            }
            normalizedBusinessData = { ...businessData, phoneNumber }
        }

        const currentBusinessData = session.businessData?.toObject?.() ?? session.businessData ?? {}
        const submittedCountryValue = normalizedBusinessData?.countryCode || normalizedBusinessData?.country
        const submittedCountryCode = submittedCountryValue
            ? resolveCountryMetadata(submittedCountryValue).countryCode
            : currentBusinessData.countryCode
        const changesValidatedAddressCountry = Boolean(
            currentBusinessData.addressPlaceId &&
            submittedCountryCode &&
            submittedCountryCode !== currentBusinessData.countryCode
        )
        const includesAddressData = normalizedBusinessData && ([
            "address",
            "addressPlaceId",
            "addressSessionToken",
            "latitude",
            "longitude"
        ].some((field) => Object.prototype.hasOwnProperty.call(normalizedBusinessData, field)) || changesValidatedAddressCountry)

        if (includesAddressData) {
            const countryMetadata = resolveCountryMetadata(
                normalizedBusinessData.countryCode || normalizedBusinessData.country
            )
            const addressPlaceId = normalizedBusinessData.addressPlaceId?.trim()
            const addressSessionToken = normalizedBusinessData.addressSessionToken?.trim()

            if (addressPlaceId && addressSessionToken) {
                const selectedAddress = await resolveGooglePlace({
                    placeId: addressPlaceId,
                    countryCode: countryMetadata.countryCode,
                    sessionToken: addressSessionToken
                })
                normalizedBusinessData = { ...normalizedBusinessData, ...selectedAddress }
            } else {
                const isPreviouslyValidatedAddress = Boolean(
                    currentBusinessData.addressPlaceId &&
                    normalizedBusinessData.address === currentBusinessData.address &&
                    normalizedBusinessData.addressPlaceId === currentBusinessData.addressPlaceId &&
                    countryMetadata.countryCode === currentBusinessData.countryCode &&
                    Number.isFinite(currentBusinessData.latitude) &&
                    Number.isFinite(currentBusinessData.longitude)
                )

                if (!isPreviouslyValidatedAddress) {
                    return res.status(400).json({ message: "Select a valid address from the suggestions" })
                }

                normalizedBusinessData = {
                    ...normalizedBusinessData,
                    address: currentBusinessData.address,
                    addressPlaceId: currentBusinessData.addressPlaceId,
                    latitude: currentBusinessData.latitude,
                    longitude: currentBusinessData.longitude
                }
            }

            delete normalizedBusinessData.addressSessionToken
        }

        if (normalizedBusinessData) {
            session.businessData = {
                ...session.businessData,
                ...normalizedBusinessData
            }
        }

        // Validate slug uniqueness early if slug is provided
        if (businessData?.slug && businessData?.country) {
            let countryCode
            try {
                countryCode = resolveCountryMetadata(businessData.country).countryCode
            } catch (err) {
                if (isCountryResolutionError(err)) {
                    return res.status(400).json({ message: err.message })
                }
                throw err
            }
            const existingSlug = await Business.findOne({ slug: businessData.slug, countryCode })
            if (existingSlug) {
                return res.status(400).json({ message: "A business with this URL already exists in this region." })
            }
        }

        await session.save()

        return res.json({
            message: "Session updated",
            currentStep: session.currentStep,
            businessData: session.businessData
        })
    } catch (err) {
        if (err instanceof PlacesServiceError) {
            return res.status(err.status).json({ message: err.message })
        }
        if (isCountryResolutionError(err)) {
            return res.status(400).json({ message: err.message })
        }
        console.error("Update session error:", err)
        return res.status(500).json({ message: "Server error updating session" })
    }
}

/**
 * Step 8: Complete Onboarding (Create Business)
 */
export async function completeOnboarding(req, res) {
    try {
        const { sessionId } = req.params

        const session = await OnboardingSession.findOne({ sessionId })
        if (!session) {
            return res.status(404).json({ message: "Session not found" })
        }

        if (!session.emailVerified) {
            return res.status(400).json({ message: "Email not verified" })
        }
        if (session.passwordPolicyVersion !== 1) {
            return res.status(409).json({
                message: "Your signup must be restarted to use the current password requirements.",
                code: "PASSWORD_POLICY_RESTART_REQUIRED",
            })
        }

        const data = session.businessData
        const missingFields = getMissingBusinessFields(data)
        if (missingFields.length) {
            return res.status(400).json({
                message: `Missing required business information: ${missingFields.map(({ label }) => label).join(", ")}`,
                fields: missingFields.map(({ field }) => field)
            })
        }

        const businessName = data.name.trim()
        const businessSlug = data.slug.trim().toLowerCase()
        const businessCountry = data.country.trim()
        const businessAddress = data.address.trim()
        const businessLatitude = Number(data.latitude)
        const businessLongitude = Number(data.longitude)
        if (
            !hasRequiredText(data.addressPlaceId) ||
            !Number.isFinite(businessLatitude) ||
            businessLatitude < -90 ||
            businessLatitude > 90 ||
            !Number.isFinite(businessLongitude) ||
            businessLongitude < -180 ||
            businessLongitude > 180
        ) {
            return res.status(400).json({ message: "Select a valid address from the suggestions" })
        }
        const businessPhoneNumber = normalizeInternationalPhoneNumber(data.phoneNumber)
        if (!businessPhoneNumber) {
            return res.status(400).json({ message: "Enter a complete, valid phone number" })
        }
        const businessContactEmail = data.contactEmail.trim().toLowerCase()

        let countryMetadata
        try {
            countryMetadata = validateCountryMetadataPayload(businessCountry, data)
        } catch (err) {
            if (isCountryResolutionError(err)) {
                return res.status(400).json({ message: err.message })
            }
            throw err
        }

        // Final slug check
        const existingSlug = await Business.findOne({ slug: businessSlug, countryCode: countryMetadata.countryCode })
        if (existingSlug) {
            return res.status(400).json({ message: "A business with this URL already exists in this region." })
        }

        // Validate plan if planId is provided
        let resolvedPlanId = data.planId
        let resolvedPlanSlug = data.plan || data.currentPlan
        
        if (resolvedPlanId) {
            const planDoc = await Plan.findById(resolvedPlanId)
            if (planDoc) {
                resolvedPlanSlug = planDoc.slug
            }
        } else if (resolvedPlanSlug) {
            const planDoc = await Plan.findOne({ slug: resolvedPlanSlug })
            if (planDoc) {
                resolvedPlanId = planDoc._id
                resolvedPlanSlug = planDoc.slug
            }
        }

        const selectedPlanSlug = resolvedPlanSlug || 'basic'

        try {
            await assertEmailAvailable(session.ownerEmail, {
                exclude: {
                    onboardingSessionObjectId: session._id,
                    onboardingSessionId: session.sessionId
                }
            })
        } catch (err) {
            if (isEmailAlreadyInUseError(err)) {
                return sendEmailInUseResponse(res)
            }
            throw err
        }

        const businessId = generateBusinessId()

        const resolvedBusinessType = data.businessType || 'restaurant'
        const business = await Business.create({
            businessId,
            businessId: businessId,
            name: businessName,
            displayName: data.displayName || businessName,
            slug: businessSlug,
            businessType: resolvedBusinessType,
            modules: getDefaultBusinessModules(resolvedBusinessType),
            address: businessAddress,
            addressPlaceId: data.addressPlaceId.trim(),
            latitude: businessLatitude,
            longitude: businessLongitude,
            phoneNumber: businessPhoneNumber,
            contactEmail: businessContactEmail,
            country: countryMetadata.country,
            countryCode: countryMetadata.countryCode,
            currency: countryMetadata.currency,
            timezone: countryMetadata.timezone,
            language: data.language || 'en',
            
            plan: selectedPlanSlug,
            currentPlan: selectedPlanSlug,
            planId: resolvedPlanId || null,
            status: "active",
            
            // Assign Owner
            ownerName: session.ownerName,
            ownerEmail: session.ownerEmail,
            ownerStatus: "active",
            ownerPasswordHash: session.passwordHash,
            
            // Post-signup Tracking
            onboardingCompleted: false, // Dashboard setup not yet finished
            onboardingStartedAt: session.createdAt,
            onboardingCompletedAt: null,
            
            setupProgress: {
                setupGuideDismissed: false
            }
        })

        // Clean up session
        await OnboardingSession.deleteOne({ _id: session._id })

        return establishOwnerSession(req, res, business, {
            success: true,
            message: "Business created successfully",
            businessId: business.businessId,
            slug: business.slug
        });
    } catch (err) {
        console.error("Complete onboarding error:", err)
        return res.status(500).json({ message: "Server error creating business" })
    }
}
