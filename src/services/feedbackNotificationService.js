import { NOTIFICATION_TYPES } from "../constants/notifications.js"
import {
    buildNotificationIdempotencyKey,
    createNotificationEvent,
} from "./notificationService.js"
import { isLowFeedbackRating } from "./feedbackRatingService.js"

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : { ...value }
}

function occurredAt(value, fallback) {
    const parsed = value instanceof Date ? new Date(value) : new Date(value || "")
    return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

export async function notifyLowRatingFeedback({
    feedback: feedbackValue,
    now = new Date(),
}, {
    createEvent = createNotificationEvent,
} = {}) {
    const feedback = plain(feedbackValue)
    if (!isLowFeedbackRating(feedback?.overallRating)) {
        return { skipped: true, reason: "rating_not_low" }
    }

    const businessId = String(feedback.businessId || "").trim()
    const entityId = String(feedback._id || feedback.id || "").trim()
    const type = NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED

    return createEvent({
        businessId,
        type,
        entityId,
        occurredAt: occurredAt(feedback.createdAt, now),
        idempotencyKey: buildNotificationIdempotencyKey({
            type,
            entityId,
            occurrenceId: "created-v1",
        }),
        facts: {
            rating: feedback.overallRating,
            servicePointDisplayName:
                feedback.servicePointDisplayName || feedback.servicePointLabel ||
                feedback.servicePointId || "",
        },
    })
}
