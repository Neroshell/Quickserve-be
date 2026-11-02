/**
 * Email clients fetch images independently. Only emit a venue image tag for a
 * well-formed HTTPS URL; the business name remains the reliable identity.
 */
export function isSafeBusinessLogoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
