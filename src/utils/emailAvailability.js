import Business from "../models/Business.js"
import Staff from "../models/Staff.js"
import OnboardingSession from "../models/OnboardingSession.js"

export const EMAIL_IN_USE_MESSAGE =
    "This email address is already associated with an existing QuickServe account. Please use a different email address."

export class EmailAlreadyInUseError extends Error {
    constructor(account) {
        super(EMAIL_IN_USE_MESSAGE)
        this.name = "EmailAlreadyInUseError"
        this.account = account
    }
}

export function normalizeAccountEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : ""
}

function asStringId(value) {
    return value ? String(value) : ""
}

function isExcluded(record, exclude = {}) {
    const recordObjectId = asStringId(record._id || record.id)
    const recordBusinessId = record.businessId || record.restaurantId || ""
    const recordStaffId = record.staffId || record.waiterId || ""
    const recordSessionId = record.sessionId || ""

    return (
        (exclude.businessObjectId && recordObjectId === asStringId(exclude.businessObjectId)) ||
        (exclude.businessId && recordBusinessId === exclude.businessId) ||
        (exclude.staffObjectId && recordObjectId === asStringId(exclude.staffObjectId)) ||
        (exclude.staffId && recordStaffId === exclude.staffId) ||
        (exclude.onboardingSessionObjectId && recordObjectId === asStringId(exclude.onboardingSessionObjectId)) ||
        (exclude.onboardingSessionId && recordSessionId === exclude.onboardingSessionId)
    )
}

function toAccount(source, type, record, emailField) {
    return {
        source,
        type,
        email: record[emailField],
        id: asStringId(record._id),
        businessId: record.businessId || record.restaurantId || undefined,
        staffId: record.staffId || record.waiterId || undefined,
        sessionId: record.sessionId || undefined,
        status: record.ownerStatus || record.accountStatus || record.currentStep || undefined,
    }
}

export async function findAccountByEmail(email, options = {}) {
    const normalizedEmail = normalizeAccountEmail(email)
    if (!normalizedEmail) return null

    const exclude = options.exclude || {}
    const [owner, pendingOwnerChange, staff, onboardingSession] = await Promise.all([
        Business.findOne({ ownerEmail: normalizedEmail })
            .select("_id businessId restaurantId ownerEmail ownerStatus")
            .lean(),
        Business.findOne({
            pendingEmailChange: normalizedEmail,
            emailChangeTokenExpires: { $gt: new Date() }
        })
            .select("_id businessId restaurantId pendingEmailChange ownerStatus")
            .lean(),
        Staff.findOne({ email: normalizedEmail })
            .select("_id businessId restaurantId staffId waiterId email role accountStatus")
            .lean(),
        OnboardingSession.findOne({ ownerEmail: normalizedEmail })
            .select("_id sessionId ownerEmail currentStep emailVerified")
            .lean(),
    ])

    const candidates = [
        owner && toAccount("business", "owner", owner, "ownerEmail"),
        pendingOwnerChange && toAccount("business", "pending_owner_email_change", pendingOwnerChange, "pendingEmailChange"),
        staff && toAccount("staff", staff.role || "staff", staff, "email"),
        onboardingSession && toAccount("onboarding_session", "pending_owner_signup", onboardingSession, "ownerEmail"),
    ].filter(Boolean)

    return candidates.find((account) => !isExcluded(account, exclude)) || null
}

export async function isEmailAvailable(email, options = {}) {
    return !(await findAccountByEmail(email, options))
}

export async function assertEmailAvailable(email, options = {}) {
    const existingAccount = await findAccountByEmail(email, options)
    if (existingAccount) {
        throw new EmailAlreadyInUseError(existingAccount)
    }
    return normalizeAccountEmail(email)
}

export function isEmailAlreadyInUseError(err) {
    return err instanceof EmailAlreadyInUseError
}

export function sendEmailInUseResponse(res, status = 409) {
    return res.status(status).json({
        success: false,
        message: EMAIL_IN_USE_MESSAGE
    })
}

function addRecord(groups, email, record) {
    const normalizedEmail = normalizeAccountEmail(email)
    if (!normalizedEmail) return
    if (!groups.has(normalizedEmail)) groups.set(normalizedEmail, [])
    groups.get(normalizedEmail).push(record)
}

export async function findDuplicateAccountEmails() {
    const [owners, pendingOwnerChanges, staff, onboardingSessions] = await Promise.all([
        Business.find({ ownerEmail: { $type: "string", $ne: "" } })
            .select("_id businessId restaurantId ownerEmail ownerStatus")
            .lean(),
        Business.find({
            pendingEmailChange: { $type: "string", $ne: "" },
            emailChangeTokenExpires: { $gt: new Date() }
        })
            .select("_id businessId restaurantId pendingEmailChange ownerStatus emailChangeTokenExpires")
            .lean(),
        Staff.find({ email: { $type: "string", $ne: "" } })
            .select("_id businessId restaurantId staffId waiterId email role accountStatus")
            .lean(),
        OnboardingSession.find({ ownerEmail: { $type: "string", $ne: "" } })
            .select("_id sessionId ownerEmail currentStep emailVerified")
            .lean(),
    ])

    const groups = new Map()

    for (const owner of owners) {
        addRecord(groups, owner.ownerEmail, toAccount("business", "owner", owner, "ownerEmail"))
    }

    for (const pendingChange of pendingOwnerChanges) {
        addRecord(groups, pendingChange.pendingEmailChange, toAccount("business", "pending_owner_email_change", pendingChange, "pendingEmailChange"))
    }

    for (const staffMember of staff) {
        addRecord(groups, staffMember.email, toAccount("staff", staffMember.role || "staff", staffMember, "email"))
    }

    for (const session of onboardingSessions) {
        addRecord(groups, session.ownerEmail, toAccount("onboarding_session", "pending_owner_signup", session, "ownerEmail"))
    }

    return Array.from(groups.entries())
        .filter(([, records]) => records.length > 1)
        .map(([email, records]) => ({ email, count: records.length, records }))
        .sort((a, b) => a.email.localeCompare(b.email))
}
