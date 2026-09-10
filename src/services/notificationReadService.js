import mongoose from "mongoose"

import Business from "../models/Business.js"
import Notification from "../models/Notification.js"
import {
    NOTIFICATION_EVENT_ACCESS,
    NOTIFICATION_RECIPIENT_KINDS,
    NOTIFICATION_TYPE_VALUES,
} from "../constants/notifications.js"
import { resolveManagementAccess } from "../constants/managementAccess.js"
import {
    resolveCurrentCoOwner,
    resolveCurrentManager,
} from "../middleware/authMiddleware.js"

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

export class NotificationReadError extends Error {
    constructor(message, statusCode = 400, code = "NOTIFICATION_READ_ERROR") {
        super(message)
        this.name = "NotificationReadError"
        this.statusCode = statusCode
        this.code = code
    }
}

async function lean(query) {
    if (typeof query?.lean === "function") return query.lean()
    return query
}

function asPlain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

function normalizeLimit(value) {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_PAGE_SIZE
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
        throw new NotificationReadError(
            `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
        )
    }
    return parsed
}

function encodeCursor(notification, context) {
    return Buffer.from(JSON.stringify({
        version: 1,
        createdAt: new Date(notification.createdAt).toISOString(),
        id: String(notification._id),
        recipientKind: context.recipientKind,
        recipientId: String(context.recipientId),
    }), "utf8").toString("base64url")
}

function decodeCursor(value, context) {
    if (!value) return null
    try {
        const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"))
        const createdAt = new Date(parsed.createdAt)
        if (
            parsed.version !== 1 ||
            Number.isNaN(createdAt.getTime()) ||
            !mongoose.isValidObjectId(parsed.id) ||
            parsed.recipientKind !== context.recipientKind ||
            parsed.recipientId !== String(context.recipientId)
        ) {
            throw new Error("invalid cursor")
        }
        return { createdAt, id: parsed.id }
    } catch {
        throw new NotificationReadError("cursor is invalid")
    }
}

function serializeNotification(value) {
    const notification = asPlain(value)
    const metadata = asPlain(notification.metadata) || {}
    delete metadata._id
    return {
        notificationId: String(notification._id),
        type: notification.type,
        category: notification.category,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
        entityType: notification.entityType,
        entityId: notification.entityId,
        occurredAt: notification.occurredAt,
        createdAt: notification.createdAt,
        readAt: notification.readAt || null,
        read: Boolean(notification.readAt),
        metadata,
    }
}

export function getAccessibleNotificationTypes(user) {
    return NOTIFICATION_TYPE_VALUES.filter((type) => {
        const access = NOTIFICATION_EVENT_ACCESS[type]
        if (user?.role === "manager" && !access.managersEligible) return false
        return resolveManagementAccess(user, {
            area: access.area,
            managerPermissions: [...access.managerPermissions],
        })
    })
}

export async function resolveNotificationAccessContext(req, {
    BusinessModel = Business,
    resolveManager = resolveCurrentManager,
    resolveCoOwner = resolveCurrentCoOwner,
} = {}) {
    const sessionUser = req.session?.user
    const businessId = typeof sessionUser?.businessId === "string"
        ? sessionUser.businessId.trim()
        : ""
    if (!businessId) {
        throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
    }

    if (sessionUser.role === "owner") {
        if (!mongoose.isValidObjectId(sessionUser.userId)) {
            throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
        }
        const business = await lean(BusinessModel.findOne({
            _id: sessionUser.userId,
            businessId,
            ownerStatus: "active",
        }).select("_id businessId ownerStatus"))
        if (!business) {
            throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
        }
        return {
            businessId,
            recipientKind: NOTIFICATION_RECIPIENT_KINDS.OWNER,
            recipientId: business._id,
            user: { role: "owner" },
        }
    }

    if (sessionUser.role === "co_owner") {
        const staff = await resolveCoOwner(req)
        if (!staff || staff.businessId !== businessId) {
            throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
        }
        return {
            businessId,
            recipientKind: NOTIFICATION_RECIPIENT_KINDS.STAFF,
            recipientId: staff._id,
            user: {
                role: "co_owner",
                coOwnerRestrictions: staff.coOwnerRestrictions || [],
            },
        }
    }

    if (sessionUser.role === "manager") {
        const staff = await resolveManager(req)
        if (!staff || staff.businessId !== businessId) {
            throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
        }
        return {
            businessId,
            recipientKind: NOTIFICATION_RECIPIENT_KINDS.STAFF,
            recipientId: staff._id,
            user: { role: "manager", permissions: staff.permissions || [] },
        }
    }

    throw new NotificationReadError("Forbidden", 403, "NOTIFICATION_FORBIDDEN")
}

function recipientScope(context, now = new Date()) {
    const types = getAccessibleNotificationTypes(context.user)
    return {
        businessId: context.businessId,
        recipientKind: context.recipientKind,
        recipientId: context.recipientId,
        type: { $in: types },
        expiresAt: { $gt: now },
    }
}

export async function listNotifications({
    context,
    cursor,
    limit,
    now = new Date(),
}, { NotificationModel = Notification } = {}) {
    const pageSize = normalizeLimit(limit)
    const decodedCursor = decodeCursor(cursor, context)
    const filter = recipientScope(context, now)
    if (decodedCursor) {
        filter.$or = [
            { createdAt: { $lt: decodedCursor.createdAt } },
            {
                createdAt: decodedCursor.createdAt,
                _id: { $lt: decodedCursor.id },
            },
        ]
    }

    const rows = await lean(NotificationModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageSize + 1))
    const hasNextPage = rows.length > pageSize
    const visible = hasNextPage ? rows.slice(0, pageSize) : rows
    return {
        notifications: visible.map(serializeNotification),
        pagination: {
            limit: pageSize,
            hasNextPage,
            nextCursor: hasNextPage
                ? encodeCursor(visible.at(-1), context)
                : null,
        },
        readThrough: now.toISOString(),
    }
}

export async function countUnreadNotifications({ context, now = new Date() }, {
    NotificationModel = Notification,
} = {}) {
    const count = await NotificationModel.countDocuments({
        ...recipientScope(context, now),
        readAt: null,
    })
    return { unreadCount: count }
}

export async function markNotificationRead({
    context,
    notificationId,
    now = new Date(),
}, { NotificationModel = Notification } = {}) {
    if (!mongoose.isValidObjectId(notificationId)) {
        throw new NotificationReadError("notificationId is invalid")
    }
    const filter = {
        _id: notificationId,
        ...recipientScope(context, now),
    }
    const existing = await lean(NotificationModel.findOne(filter))
    if (!existing) {
        throw new NotificationReadError("Notification was not found", 404)
    }
    if (existing.readAt) return { notification: serializeNotification(existing) }

    const updated = await lean(NotificationModel.findOneAndUpdate({
        ...filter,
        readAt: null,
    }, { $set: { readAt: now } }, { new: true }))
    if (updated) return { notification: serializeNotification(updated) }
    const concurrentlyUpdated = await lean(NotificationModel.findOne(filter))
    return {
        notification: serializeNotification(concurrentlyUpdated || existing),
    }
}

export async function markAllNotificationsRead({
    context,
    readThrough,
    now = new Date(),
}, { NotificationModel = Notification } = {}) {
    const cutoff = new Date(readThrough)
    if (Number.isNaN(cutoff.getTime())) {
        throw new NotificationReadError("readThrough must be a valid date")
    }
    if (cutoff.getTime() > now.getTime()) {
        throw new NotificationReadError("readThrough cannot be in the future")
    }

    const result = await NotificationModel.updateMany({
        ...recipientScope(context, now),
        readAt: null,
        createdAt: { $lte: cutoff },
    }, { $set: { readAt: now } })
    return {
        markedReadCount: Number(result?.modifiedCount || 0),
        readAt: now.toISOString(),
        readThrough: cutoff.toISOString(),
    }
}
