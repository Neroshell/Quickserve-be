import crypto from 'crypto'
import bcrypt from 'bcrypt'
import Business from '../models/Business.js'
import OnboardingSession from '../models/OnboardingSession.js'
import Plan from '../models/Plan.js'
import { hashToken } from '../utils/tokenHash.js'
import { sendOnboardingVerificationCode } from '../utils/emailService.js'
import { deriveCountryCode } from '../utils/countryHelper.js'

const VERIFICATION_CODE_TTL_MS = 30 * 60 * 1000

function generateBusinessId() {
    return `rest_${crypto.randomBytes(7).toString("hex")}`
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

function buildVerificationLink(email, verificationCode) {
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:3000'
    return `${frontendBaseUrl}/onboarding?token=${verificationCode}&email=${encodeURIComponent(email)}`
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

        const normalizedEmail = email.trim().toLowerCase()

        // Check if owner already exists in Business
        const existingBusinessOwner = await Business.findOne({ ownerEmail: normalizedEmail })
        if (existingBusinessOwner) {
            return res.status(409).json({ message: "An account with this email already exists." })
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
                    emailVerified: false,
                    verificationToken: hashToken(verificationCode),
                    verificationTokenExpires,
                    currentStep: 'verify_email',
                    businessData: {}
                }
            },
            { new: true, upsert: true }
        )

        const verificationLink = buildVerificationLink(normalizedEmail, verificationCode)
        const emailSent = await sendOnboardingVerificationCode({ 
            to: normalizedEmail, 
            userName: ownerName, 
            verificationCode,
            verificationLink
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
        if (!email) {
            return res.status(400).json({ message: "Email is required" })
        }

        const normalizedEmail = email.trim().toLowerCase()
        const session = await OnboardingSession.findOne({ ownerEmail: normalizedEmail })

        if (!session) {
            return res.status(404).json({ message: "No pending onboarding session found for this email." })
        }

        if (session.emailVerified) {
            return res.status(400).json({ message: "Email is already verified." })
        }

        const verificationCode = generateVerificationCode()
        session.verificationToken = hashToken(verificationCode)
        session.verificationTokenExpires = getVerificationExpiresAt()
        session.currentStep = 'verify_email'
        await session.save()

        const verificationLink = buildVerificationLink(normalizedEmail, verificationCode)
        const emailSent = await sendOnboardingVerificationCode({
            to: normalizedEmail,
            userName: session.ownerName,
            verificationCode,
            verificationLink
        })

        if (!emailSent) {
            return res.status(502).json({ message: "Could not send the verification code. Please try again shortly." })
        }

        return res.json({ message: "Verification code sent." })
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
        if (!email || !token) {
            return res.status(400).json({ message: "Email and token are required" })
        }

        const normalizedEmail = email.trim().toLowerCase()
        const hashedToken = hashToken(token)

        const session = await OnboardingSession.findOne({ 
            ownerEmail: normalizedEmail,
            verificationToken: hashedToken,
            verificationTokenExpires: { $gt: new Date() }
        })

        if (!session) {
            return res.status(400).json({ message: "Invalid or expired verification token." })
        }

        session.emailVerified = true
        session.verificationToken = undefined
        session.verificationTokenExpires = undefined
        session.currentStep = 'business_identity'
        await session.save()

        return res.json({ 
            message: "Email verified successfully",
            sessionId: session.sessionId
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
        
        if (businessData) {
            session.businessData = {
                ...session.businessData,
                ...businessData
            }
        }

        // Validate slug uniqueness early if slug is provided
        if (businessData?.slug && businessData?.country) {
            const countryCode = deriveCountryCode(businessData.country)
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
        const businessPhoneNumber = data.phoneNumber.trim()
        const businessContactEmail = data.contactEmail.trim().toLowerCase()

        const countryCode = deriveCountryCode(businessCountry)

        // Final slug check
        const existingSlug = await Business.findOne({ slug: businessSlug, countryCode })
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

        const businessId = generateBusinessId()

        const business = await Business.create({
            businessId,
            restaurantId: businessId,
            name: businessName,
            displayName: data.displayName || businessName,
            slug: businessSlug,
            businessType: data.businessType || 'restaurant',
            address: businessAddress,
            phoneNumber: businessPhoneNumber,
            contactEmail: businessContactEmail,
            country: businessCountry,
            countryCode,
            currency: data.currency || 'USD',
            timezone: data.timezone || 'America/New_York',
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
            onboardingCompletedAt: new Date(),
            
            // Pre-fill setup checklist based on sensible defaults
            setupChecklist: {
                businessProfileCompleted: false,
                operatingHoursCompleted: false,
                preferencesCompleted: false,
                billingCardCompleted: false,
                stripeConnectCompleted: false,
                servicePointsCompleted: false,
                menuCompleted: false,
                teamCompleted: false,
                previewCompleted: false
            },
            setupProgress: {
                setupGuideDismissed: false
            }
        })

        // Clean up session
        await OnboardingSession.deleteOne({ _id: session._id })

        return res.status(201).json({
            message: "Business created successfully",
            businessId: business.businessId,
            slug: business.slug
        })
    } catch (err) {
        console.error("Complete onboarding error:", err)
        return res.status(500).json({ message: "Server error creating business" })
    }
}
