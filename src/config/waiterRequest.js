/**
 * Waiter request cooldown configuration.
 *
 * Controls how long a customer must wait before they can create a new
 * waiter request for the same service point after a previous request
 * was created (unless the request is resolved earlier by staff).
 *
 * Controlled via WAITER_REQUEST_COOLDOWN_MINUTES environment variable.
 * Falls back to 10 minutes when unset or invalid.
 */
const DEFAULT_COOLDOWN_MINUTES = 10

export function resolveCooldownMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_COOLDOWN_MINUTES
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_COOLDOWN_MINUTES
  }
  return parsed
}

export function getWaiterRequestCooldownMinutes() {
  return resolveCooldownMinutes(process.env.WAITER_REQUEST_COOLDOWN_MINUTES)
}

export function getWaiterRequestCooldownMs() {
  return getWaiterRequestCooldownMinutes() * 60 * 1000
}