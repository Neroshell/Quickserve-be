import { DateTime } from "luxon"

export const ANALYTICS_BUSINESS_TZ =
    process.env.BUSINESS_TZ || "Europe/Malta"
export const ANALYTICS_ROLLOVER_HOUR = Number(
    process.env.BUSINESS_DAY_ROLLOVER_HOUR || 2
)

export class AnalyticsRangeError extends Error {
    constructor(message) {
        super(message)
        this.name = "AnalyticsRangeError"
        this.statusCode = 400
    }
}

function asDateTime(now, timezone) {
    if (DateTime.isDateTime(now)) return now.setZone(timezone)
    if (now instanceof Date) return DateTime.fromJSDate(now).setZone(timezone)
    return DateTime.now().setZone(timezone)
}

export function getAnalyticsBusinessDayRange({
    now,
    timezone = ANALYTICS_BUSINESS_TZ,
    rolloverHour = ANALYTICS_ROLLOVER_HOUR,
} = {}) {
    const zonedNow = asDateTime(now, timezone)
    const isBeforeRollover = zonedNow.hour < rolloverHour
    const baseDay = isBeforeRollover
        ? zonedNow.minus({ days: 1 })
        : zonedNow

    const start = baseDay
        .startOf("day")
        .set({
            hour: rolloverHour,
            minute: 0,
            second: 0,
            millisecond: 0,
        })

    return {
        start,
        end: start.plus({ days: 1 }),
    }
}

/**
 * Resolve the existing food-service analytics date presets.
 *
 * Phase 1 deliberately retains the process-wide timezone and 02:00 rollover
 * behavior used by the previous ownerAnalytics controller.
 */
export function resolveAnalyticsRange({
    preset = "today",
    from,
    to,
    now,
    timezone = ANALYTICS_BUSINESS_TZ,
    rolloverHour = ANALYTICS_ROLLOVER_HOUR,
} = {}) {
    const { start: todayStart, end: todayEnd } =
        getAnalyticsBusinessDayRange({ now, timezone, rolloverHour })

    let start
    let end

    switch (preset) {
        case "today":
            start = todayStart
            end = todayEnd
            break
        case "yesterday":
            start = todayStart.minus({ days: 1 })
            end = todayEnd.minus({ days: 1 })
            break
        case "7days":
            start = todayStart.minus({ days: 6 })
            end = todayEnd
            break
        case "thisMonth":
            start = todayStart
                .startOf("month")
                .set({
                    hour: rolloverHour,
                    minute: 0,
                    second: 0,
                    millisecond: 0,
                })
            end = todayEnd
            break
        case "custom": {
            if (!from || !to) {
                throw new AnalyticsRangeError(
                    "Missing 'from' or 'to' for custom range"
                )
            }

            const customStart = DateTime.fromISO(from, { zone: timezone }).set({
                hour: rolloverHour,
                minute: 0,
                second: 0,
                millisecond: 0,
            })
            const customTo = DateTime.fromISO(to, { zone: timezone }).set({
                hour: rolloverHour,
                minute: 0,
                second: 0,
                millisecond: 0,
            })

            if (!customStart.isValid || !customTo.isValid) {
                throw new AnalyticsRangeError(
                    "Invalid date format for custom range"
                )
            }
            if (customStart > customTo) {
                throw new AnalyticsRangeError(
                    "Invalid custom range: 'from' must be on or before 'to'"
                )
            }

            start = customStart
            end = customTo.plus({ days: 1 })
            break
        }
        default:
            // Preserve the controller's historical fallback for unknown presets.
            start = todayStart
            end = todayEnd
    }

    return {
        preset,
        startDate: start.toJSDate(),
        endDate: end.toJSDate(),
        from,
        to,
        timezone,
    }
}
