import { DateTime } from "luxon"

export function getNextOpeningTime(operatingHours, tz, nowDateTime) {
    if (!operatingHours) return "later"

    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    const currentDayName = nowDateTime.toFormat("EEEE")
    const currentTimeStr = nowDateTime.toFormat("HH:mm")

    let nextOpeningTime = null;
    let daysChecked = 0;
    
    let pointerDayIndex = dayNames.indexOf(currentDayName)
    if (pointerDayIndex === -1) pointerDayIndex = 0 // Safety fallback
    
    while (daysChecked < 7) {
        const checkDay = dayNames[pointerDayIndex];
        const hours = operatingHours[checkDay];
        
        if (hours?.enabled) {
            if (daysChecked === 0) {
                // Today, is the openTime in the future?
                if (currentTimeStr < hours.openTime) {
                    nextOpeningTime = `today at ${hours.openTime}`
                    break
                }
            } else if (daysChecked === 1) {
                nextOpeningTime = `tomorrow at ${hours.openTime}`
                break
            } else {
                nextOpeningTime = `${checkDay} at ${hours.openTime}`
                break
            }
        }
        
        pointerDayIndex = (pointerDayIndex + 1) % 7
        daysChecked++
    }

    return nextOpeningTime || "later this week"
}

export function isBusinessOpen(business) {
    if (!business || !business.operatingHours) {
        return { isOpen: true }
    }

    const tz = business.timezone || "UTC"
    
    let now;
    try {
        now = DateTime.now().setZone(tz)
    } catch (err) {
        now = DateTime.now().setZone("UTC") // Fallback
    }
    
    const currentDayName = now.toFormat("EEEE") // e.g. "Monday"
    const currentTimeStr = now.toFormat("HH:mm")

    const todayHours = business.operatingHours[currentDayName]

    if (todayHours?.enabled) {
        // Simple string comparison for HH:mm
        if (currentTimeStr >= todayHours.openTime && currentTimeStr <= todayHours.closeTime) {
            return { isOpen: true }
        }
    }

    const nextOpeningTime = getNextOpeningTime(business.operatingHours, tz, now)

    return {
        isOpen: false,
        nextOpeningTime
    }
}
