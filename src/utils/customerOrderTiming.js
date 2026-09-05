export const DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES = 10
export const MIN_ORDER_START_ASSISTANCE_DELAY_MINUTES = 1
export const MAX_ORDER_START_ASSISTANCE_DELAY_MINUTES = 240

export function isValidOrderStartAssistanceDelayMinutes(value) {
  return Number.isInteger(value) &&
    value >= MIN_ORDER_START_ASSISTANCE_DELAY_MINUTES &&
    value <= MAX_ORDER_START_ASSISTANCE_DELAY_MINUTES
}

export function resolveOrderStartAssistanceDelayMinutes(value) {
  const parsed = typeof value === "number" ? value : Number(value)
  return isValidOrderStartAssistanceDelayMinutes(parsed)
    ? parsed
    : DEFAULT_ORDER_START_ASSISTANCE_DELAY_MINUTES
}

export function isCallWaiterEnabledForBusiness(business) {
  return business?.orderingPreferences?.callWaiterEnabled ??
    business?.settings?.callWaiterEnabled ??
    true
}

export function getCustomerProgressOptionsForBusiness(business) {
  return {
    assistanceEnabled: isCallWaiterEnabledForBusiness(business),
    orderStartAssistanceDelayMinutes: resolveOrderStartAssistanceDelayMinutes(
      business?.orderingPreferences?.orderStartAssistanceDelayMinutes,
    ),
  }
}
