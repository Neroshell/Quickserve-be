import Business from "../models/Business.js"
import Staff from "../models/Staff.js"
import { NOTIFICATION_RECIPIENT_KINDS } from "../constants/notifications.js"
import { resolveManagementAccess } from "../constants/managementAccess.js"

export class NotificationRecipientError extends Error {
    constructor(message, statusCode = 400) {
        super(message)
        this.name = "NotificationRecipientError"
        this.statusCode = statusCode
    }
}

async function lean(query, session = null) {
    let nextQuery = query
    if (session && typeof nextQuery?.session === "function") {
        nextQuery = nextQuery.session(session)
    }
    if (typeof nextQuery?.lean === "function") return nextQuery.lean()
    return nextQuery
}

function canReceive(staff, access) {
    if (staff.role === "co_owner") {
        return resolveManagementAccess({
            role: staff.role,
            coOwnerRestrictions: staff.coOwnerRestrictions || [],
        }, { area: access.requiredAccessArea })
    }

    if (staff.role === "manager" && access.managersEligible) {
        return resolveManagementAccess({
            role: staff.role,
            permissions: staff.permissions || [],
        }, {
            area: access.requiredAccessArea,
            managerPermissions: access.managerPermissions,
        })
    }

    return false
}

/**
 * Resolve and freeze concrete recipients when the durable event intent is
 * recorded. Later permission grants therefore do not create historical
 * recipients, while read APIs can still enforce current access.
 */
export async function resolveNotificationRecipients({
    businessId,
    requiredAccessArea,
    managerPermissions = [],
    managersEligible = true,
}, {
    BusinessModel = Business,
    StaffModel = Staff,
    session = null,
} = {}) {
    const normalizedBusinessId = String(businessId || "").trim()
    if (!normalizedBusinessId) {
        throw new NotificationRecipientError("businessId is required")
    }

    // Keep these sequential because MongoDB does not support parallel
    // operations on the same transaction session.
    const business = await lean(
        BusinessModel.findOne({ businessId: normalizedBusinessId })
            .select("_id businessId ownerStatus"),
        session,
    )
    const staff = await lean(
        StaffModel.find({
            businessId: normalizedBusinessId,
            accountStatus: "active",
            role: { $in: ["co_owner", "manager"] },
        }).select(
            "_id businessId role accountStatus permissions coOwnerRestrictions",
        ),
        session,
    )

    if (!business) {
        throw new NotificationRecipientError("Business was not found", 404)
    }

    const access = { requiredAccessArea, managerPermissions, managersEligible }
    const recipients = []
    if (business.ownerStatus === "active") {
        recipients.push({
            recipientKind: NOTIFICATION_RECIPIENT_KINDS.OWNER,
            recipientId: business._id,
            role: "owner",
        })
    }

    for (const account of staff || []) {
        if (!canReceive(account, access)) continue
        recipients.push({
            recipientKind: NOTIFICATION_RECIPIENT_KINDS.STAFF,
            recipientId: account._id,
            role: account.role,
        })
    }

    const unique = new Map()
    for (const recipient of recipients) {
        unique.set(
            `${recipient.recipientKind}:${String(recipient.recipientId)}`,
            recipient,
        )
    }
    return [...unique.values()]
}
