import { DateTime } from 'luxon'

const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function getClosingTime(businessDayDate, operatingHours) {
    const weekday = businessDayDate.toFormat('EEEE')
    const config = operatingHours[weekday] || {}
    const openTime = config.openTime || "09:00"
    const closeTime = config.closeTime || "22:00"
    
    const [closeH, closeM] = closeTime.split(':').map(Number)
    
    let isNextDay = closeTime < openTime
    if (closeTime === "00:00" && openTime === "00:00") {
        isNextDay = true // 24-hour operation closes at the end of the day
    }
    
    if (isNextDay) {
        return businessDayDate.plus({ days: 1 }).set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 })
    } else {
        return businessDayDate.set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 })
    }
}

/**
 * Resolves the operational business day for a given timestamp based on business configuration.
 * @param {Object} business - The business configuration.
 * @param {string} business.timezone - The business timezone (e.g., "Europe/Malta").
 * @param {Object} business.operatingHours - Weekday configurations with openTime and closeTime.
 * @param {Date|string|undefined} nowUtc - The UTC timestamp to evaluate (defaults to now).
 * @returns {Object} - The resolved business day details.
 */
export function resolveBusinessDay(business, nowUtc = undefined) {
    const timezone = business.timezone || "Europe/Malta"
    const operatingHours = business.operatingHours || {}

    const localTime = nowUtc 
        ? (typeof nowUtc === 'string' ? DateTime.fromISO(nowUtc).setZone(timezone) : DateTime.fromJSDate(nowUtc).setZone(timezone))
        : DateTime.now().setZone(timezone)

    const currentCalendarDay = localTime.startOf('day')
    const todayClosingTime = getClosingTime(currentCalendarDay, operatingHours)
    const yesterdayClosingTime = getClosingTime(currentCalendarDay.minus({ days: 1 }), operatingHours)

    let targetBusinessDayDate
    
    if (localTime >= todayClosingTime) {
        targetBusinessDayDate = currentCalendarDay.plus({ days: 1 })
    } else if (localTime < yesterdayClosingTime) {
        targetBusinessDayDate = currentCalendarDay.minus({ days: 1 })
    } else {
        targetBusinessDayDate = currentCalendarDay
    }

    const previousBusinessDayDate = targetBusinessDayDate.minus({ days: 1 })
    
    const startLocal = getClosingTime(previousBusinessDayDate, operatingHours)
    const endLocalExclusive = getClosingTime(targetBusinessDayDate, operatingHours)

    return {
        businessDay: targetBusinessDayDate.toISODate(), // "YYYY-MM-DD"
        startUtc: startLocal.toJSDate(),
        endUtcExclusive: endLocalExclusive.toJSDate(),
        timezone,
        generatedAt: localTime.toISO()
    }
}

/**
 * Resolves the immediately previous operational business day.
 * Uses the same timezone-aware, operating-hours-aware logic as resolveBusinessDay
 * by rewinding 1ms before the current business day's start.
 *
 * @param {Object} business - The business configuration.
 * @param {Date|string|undefined} nowUtc - The UTC timestamp to evaluate (defaults to now).
 * @returns {Object} { businessDay, startUtc, endUtcExclusive, timezone, generatedAt }
 */
export function resolvePreviousBusinessDay(business, nowUtc = undefined) {
    const current = resolveBusinessDay(business, nowUtc)
    // The current business day starts at the previous day's closing time.
    // Subtract 1ms to land in the previous business day.
    const previousMoment = new Date(current.startUtc.getTime() - 1)
    return resolveBusinessDay(business, previousMoment)
}
