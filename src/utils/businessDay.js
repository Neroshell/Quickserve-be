import { DateTime } from "luxon"

/**
 * Derives the current business-day window for a given business.
 *
 * The business's closing time is used as the rollover point:
 *   - Before closeTime  → still in the business day that started at closeTime *yesterday*
 *   - After  closeTime  → in the business day that started at closeTime *today*
 *
 * @param {Object} business - Mongoose doc or plain object with { timezone, operatingHours }
 * @returns {{ startJS, endJS, start, end, businessDay, generatedAt, tz, rolloverHour, rolloverMinute }}
 */
export function getBusinessDayRange(business) {
  const tz = business?.timezone || "UTC"
  const operatingHours = business?.operatingHours || {}

  let now
  try {
    now = DateTime.now().setZone(tz)
  } catch {
    now = DateTime.now().setZone("UTC")
  }

  const dayName = now.toFormat("EEEE") // "Monday", "Tuesday", …
  const todayHours = operatingHours[dayName]

  // Parse closeTime → rollover hour/minute
  // Fall back to end-of-day (23:59) when hours aren't configured for today
  let rolloverHour = 23
  let rolloverMinute = 59

  if (todayHours?.enabled && todayHours?.closeTime) {
    const [h, m] = todayHours.closeTime.split(":").map(Number)
    rolloverHour = h
    rolloverMinute = m || 0
  }

  // Preserve the original rollover logic — same math, dynamic values
  const isBeforeRollover =
    now.hour < rolloverHour ||
    (now.hour === rolloverHour && now.minute < rolloverMinute)

  const baseDay = isBeforeRollover ? now.minus({ days: 1 }) : now

  const start = baseDay
    .startOf("day")
    .set({ hour: rolloverHour, minute: rolloverMinute, second: 0, millisecond: 0 })

  const end = start.plus({ days: 1 })

  return {
    startJS: start.toJSDate(),
    endJS: end.toJSDate(),
    start,   // Luxon DateTime — used by ownerController for date arithmetic
    end,     // Luxon DateTime
    businessDay: start.toISODate(),
    generatedAt: now.toISO(),
    tz,
    rolloverHour,
    rolloverMinute,
  }
}
