const DEFAULT_ESTIMATED_PREP_MINUTES = 10

function normalizeMinutes(value) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 1) return null
  return Math.ceil(minutes)
}

export function getItemPrepTimeMinutes(menuItem) {
  const isDirect = menuItem?.fulfillmentBehavior === "direct" ||
    (!menuItem?.fulfillmentBehavior && menuItem?.type === "drinks")
  if (isDirect) return null
  return normalizeMinutes(menuItem?.prepTimeMinutes) || DEFAULT_ESTIMATED_PREP_MINUTES
}

export function getEstimatedPrepMinutes(items = []) {
  const prepTimes = items
    .map((item) => normalizeMinutes(item?.prepTimeMinutes))
    .filter((minutes) => minutes !== null)

  if (prepTimes.length === 0) {
    const allDirect = items.length > 0 && items.every((item) => (
      item?.fulfillmentBehavior === "direct" ||
      (!item?.fulfillmentBehavior && item?.type === "drinks")
    ))
    return allDirect ? 0 : DEFAULT_ESTIMATED_PREP_MINUTES
  }
  return Math.max(...prepTimes)
}

export function buildOrderEstimate(items = [], createdAt = new Date()) {
  const estimatedPrepMinutes = getEstimatedPrepMinutes(items)
  const start = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const startMs = Number.isFinite(start.getTime()) ? start.getTime() : Date.now()

  return {
    estimatedPrepMinutes,
    estimatedReadyAt: new Date(startMs + estimatedPrepMinutes * 60 * 1000),
  }
}
