import {
    NotificationReadError,
    countUnreadNotifications,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    resolveNotificationAccessContext,
} from "../services/notificationReadService.js"
import { NOTIFICATION_EVENT_ACCESS } from "../constants/notifications.js"
import { publishNotificationChanged } from "../utils/sseManager.js"

async function invalidateRecipient(context, notification = null) {
    const access = notification?.type
        ? NOTIFICATION_EVENT_ACCESS[notification.type]
        : null
    await publishNotificationChanged({
        businessId: context.businessId,
        recipients: [{
            recipientKind: context.recipientKind,
            recipientId: context.recipientId,
        }],
        requiredAccessArea: access?.area || null,
        requiredPermission: access?.managerPermissions?.[0] || null,
    })
}

function sendError(res, error) {
    if (error instanceof NotificationReadError) {
        return res.status(error.statusCode).json({ message: error.message })
    }
    console.error("[Notifications] Request failed", {
        reason: error?.code || error?.name || "notification_request_failed",
    })
    return res.status(500).json({ message: "Unable to process notifications." })
}

export async function getNotifications(req, res) {
    try {
        const context = await resolveNotificationAccessContext(req)
        const result = await listNotifications({
            context,
            cursor: req.query?.cursor,
            limit: req.query?.limit,
        })
        return res.json(result)
    } catch (error) {
        return sendError(res, error)
    }
}

export async function getUnreadNotificationCount(req, res) {
    try {
        const context = await resolveNotificationAccessContext(req)
        return res.json(await countUnreadNotifications({ context }))
    } catch (error) {
        return sendError(res, error)
    }
}

export async function readNotification(req, res) {
    try {
        const context = await resolveNotificationAccessContext(req)
        const result = await markNotificationRead({
            context,
            notificationId: req.params?.notificationId,
        })
        await invalidateRecipient(context, result.notification)
        return res.json(result)
    } catch (error) {
        return sendError(res, error)
    }
}

export async function readAllNotifications(req, res) {
    try {
        const context = await resolveNotificationAccessContext(req)
        const result = await markAllNotificationsRead({
            context,
            readThrough: req.body?.readThrough,
        })
        await invalidateRecipient(context)
        return res.json(result)
    } catch (error) {
        return sendError(res, error)
    }
}
