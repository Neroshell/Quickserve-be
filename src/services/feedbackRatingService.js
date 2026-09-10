export const FEEDBACK_LOW_RATING_MAX = 2

export function isLowFeedbackRating(value) {
    const rating = Number(value)
    return Number.isFinite(rating) && rating >= 1 && rating <= FEEDBACK_LOW_RATING_MAX
}

export function classifyFeedbackSentiment(value) {
    const rating = Number(value)
    if (rating >= 4) return "positive"
    if (isLowFeedbackRating(rating)) return "negative"
    return "neutral"
}
