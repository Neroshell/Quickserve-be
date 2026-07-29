import { DateTime, IANAZone } from "luxon"

export const DEFAULT_ANALYTICS_TIMEZONE = "UTC"
export const FOOD_SERVICE_ROLLOVER_HOUR = 2
export const LODGING_CALENDAR_ROLLOVER_HOUR = 0
export const MAX_CUSTOM_ANALYTICS_DAYS = 366

const SUPPORTED_PRESETS = new Set([
    "today",
    "yesterday",
    "7days",
    "thisMonth",
    "custom",
])

export class AnalyticsRangeError extends Error {
    constructor(message) {
        super(message)
        this.name = "AnalyticsRangeError"
        this.statusCode = 400
    }
}

export function resolveAnalyticsTimezone(
    timezone,
    fallback = DEFAULT_ANALYTICS_TIMEZONE
) {
    const candidate =
        typeof timezone === "string" ? timezone.trim() : ""
    if (candidate && IANAZone.isValidZone(candidate)) return candidate
    return fallback
}

function asDateTime(now, timezone) {
    if (DateTime.isDateTime(now)) return now.setZone(timezone)
    if (now instanceof Date) {
        return DateTime.fromJSDate(now, { zone: timezone })
    }
    return DateTime.now().setZone(timezone)
}

function parseLocalDate(value, timezone, fieldName) {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        throw new AnalyticsRangeError(
            `'${fieldName}' must be a valid local ISO date`
        )
    }

    const parsed = DateTime.fromISO(value, {
        zone: timezone,
        setZone: true,
    }).startOf("day")

    if (!parsed.isValid || parsed.toISODate() !== value) {
        throw new AnalyticsRangeError(
            `'${fieldName}' must be a valid local ISO date`
        )
    }

    return parsed
}

/**
 * Resolve a local calendar date to the food-service operational rollover.
 *
 * Constructing each boundary independently is intentional: adding 24 hours
 * would be wrong across DST. Luxon resolves a nonexistent 02:00 spring-forward
 * boundary to the first valid local instant and preserves the local 02:00
 * boundary on ordinary and fall-back days.
 */
function atRollover(localDate, timezone, rolloverHour) {
    return DateTime.fromObject(
        {
            year: localDate.year,
            month: localDate.month,
            day: localDate.day,
            hour: rolloverHour,
            minute: 0,
            second: 0,
            millisecond: 0,
        },
        { zone: timezone }
    )
}

function getCurrentBusinessDate({ now, timezone, rolloverHour }) {
    const zonedNow = asDateTime(now, timezone)
    const calendarDate = zonedNow.startOf("day")
    const todayRollover = atRollover(
        calendarDate,
        timezone,
        rolloverHour
    )

    return zonedNow < todayRollover
        ? calendarDate.minus({ days: 1 })
        : calendarDate
}

function inclusiveDayCount(fromDate, toDate) {
    return Math.round(
        toDate.startOf("day").diff(fromDate.startOf("day"), "days").days
    ) + 1
}

function resolveComparisonDates({
    preset,
    currentFrom,
    currentTo,
}) {
    if (preset === "thisMonth") {
        // Month-to-date compares with the equivalent elapsed portion of the
        // previous month. If that month is shorter, its final day is used.
        const previousMonthFrom = currentFrom
            .minus({ months: 1 })
            .startOf("month")
        const elapsedDayIndex = currentTo.day - 1
        const previousMonthEnd = previousMonthFrom.endOf("month").startOf(
            "day"
        )
        const candidateTo = previousMonthFrom.plus({
            days: elapsedDayIndex,
        })

        return {
            from: previousMonthFrom,
            to:
                candidateTo > previousMonthEnd
                    ? previousMonthEnd
                    : candidateTo,
        }
    }

    const dayCount = inclusiveDayCount(currentFrom, currentTo)
    const comparisonTo = currentFrom.minus({ days: 1 })
    return {
        from: comparisonTo.minus({ days: dayCount - 1 }),
        to: comparisonTo,
    }
}

export function resolveAnalyticsRange({
    preset = "today",
    from,
    to,
    now,
    timezone,
    rolloverHour = FOOD_SERVICE_ROLLOVER_HOUR,
    maxCustomDays = MAX_CUSTOM_ANALYTICS_DAYS,
} = {}) {
    if (!SUPPORTED_PRESETS.has(preset)) {
        throw new AnalyticsRangeError(
            `Unsupported analytics range preset: ${String(preset)}`
        )
    }

    const resolvedTimezone = resolveAnalyticsTimezone(timezone)
    const businessDate = getCurrentBusinessDate({
        now,
        timezone: resolvedTimezone,
        rolloverHour,
    })

    let currentFrom
    let currentTo

    switch (preset) {
        case "today":
            currentFrom = businessDate
            currentTo = businessDate
            break
        case "yesterday":
            currentFrom = businessDate.minus({ days: 1 })
            currentTo = currentFrom
            break
        case "7days":
            currentFrom = businessDate.minus({ days: 6 })
            currentTo = businessDate
            break
        case "thisMonth":
            currentFrom = businessDate.startOf("month")
            currentTo = businessDate
            break
        case "custom": {
            if (!from || !to) {
                throw new AnalyticsRangeError(
                    "Missing 'from' or 'to' for custom range"
                )
            }

            currentFrom = parseLocalDate(
                from,
                resolvedTimezone,
                "from"
            )
            currentTo = parseLocalDate(to, resolvedTimezone, "to")

            if (currentFrom > currentTo) {
                throw new AnalyticsRangeError(
                    "Invalid custom range: 'from' must be on or before 'to'"
                )
            }

            const customDays = inclusiveDayCount(
                currentFrom,
                currentTo
            )
            if (customDays > maxCustomDays) {
                throw new AnalyticsRangeError(
                    `Custom analytics range cannot exceed ${maxCustomDays} days`
                )
            }
            break
        }
    }

    const comparisonDates = resolveComparisonDates({
        preset,
        currentFrom,
        currentTo,
    })
    const currentStart = atRollover(
        currentFrom,
        resolvedTimezone,
        rolloverHour
    )
    const currentEnd = atRollover(
        currentTo.plus({ days: 1 }),
        resolvedTimezone,
        rolloverHour
    )
    const comparisonStart = atRollover(
        comparisonDates.from,
        resolvedTimezone,
        rolloverHour
    )
    const comparisonEnd = atRollover(
        comparisonDates.to.plus({ days: 1 }),
        resolvedTimezone,
        rolloverHour
    )

    return {
        preset,
        timezone: resolvedTimezone,
        rolloverHour,
        from: currentFrom.toISODate(),
        to: currentTo.toISODate(),
        startUtc: currentStart.toUTC().toJSDate(),
        endUtcExclusive: currentEnd.toUTC().toJSDate(),
        comparison: {
            from: comparisonDates.from.toISODate(),
            to: comparisonDates.to.toISODate(),
            startUtc: comparisonStart.toUTC().toJSDate(),
            endUtcExclusive: comparisonEnd.toUTC().toJSDate(),
        },
    }
}

export function resolveAnalyticsDomainRanges(options = {}) {
    const timezone = resolveAnalyticsTimezone(options.timezone)
    const sharedOptions = {
        ...options,
        timezone,
    }

    return {
        foodOperationalRange: resolveAnalyticsRange({
            ...sharedOptions,
            rolloverHour: FOOD_SERVICE_ROLLOVER_HOUR,
        }),
        lodgingCalendarRange: resolveAnalyticsRange({
            ...sharedOptions,
            rolloverHour: LODGING_CALENDAR_ROLLOVER_HOUR,
        }),
    }
}

export function toAnalyticsRangeContract(range) {
    return {
        preset: range.preset,
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        startUtc: range.startUtc.toISOString(),
        endUtcExclusive: range.endUtcExclusive.toISOString(),
        comparison: {
            from: range.comparison.from,
            to: range.comparison.to,
            startUtc: range.comparison.startUtc.toISOString(),
            endUtcExclusive:
                range.comparison.endUtcExclusive.toISOString(),
        },
    }
}

export function toAnalyticsDomainRangeContract({
    foodOperationalRange,
    lodgingCalendarRange,
}) {
    const foodOperational =
        toAnalyticsRangeContract(foodOperationalRange)
    const lodgingCalendar =
        toAnalyticsRangeContract(lodgingCalendarRange)

    // Preserve the Phase 2 range fields as the food operational range while
    // exposing both domain boundaries explicitly. Existing food-service
    // consumers remain compatible and lodging never inherits the 02:00
    // operational rollover.
    return {
        ...foodOperational,
        foodOperationalRange: foodOperational,
        lodgingCalendarRange: lodgingCalendar,
    }
}

export function enumerateAnalyticsLocalDates({
    from,
    to,
    timezone,
}) {
    const dates = []
    let current = DateTime.fromISO(from, {
        zone: timezone,
    }).startOf("day")
    const finalDate = DateTime.fromISO(to, {
        zone: timezone,
    }).startOf("day")

    while (current <= finalDate) {
        dates.push(current.toISODate())
        current = current.plus({ days: 1 })
    }

    return dates
}
