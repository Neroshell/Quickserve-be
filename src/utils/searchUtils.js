/**
 * Canonical search input sanitization for all owner-facing read paths.
 *
 * Consolidates the duplicate `escapeRegex` / `escapeSearchExpression` helpers
 * that were independently copy-pasted across six services and controllers.
 *
 * Rules:
 *   - Trim whitespace
 *   - Bound to a maximum length (default 100 characters)
 *   - Escape all regex metacharacters so user input is always literal
 *
 * @module utils/searchUtils
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Maximum character count for user-supplied search strings.  Keeps MongoDB
 * regex evaluation predictable and prevents payload-size abuse.
 */
export const MAX_SEARCH_LENGTH = 100;

/**
 * Escapes all regular expression metacharacters in the given string.
 *
 * @param {string} value - Raw string to escape.
 * @returns {string} Escaped string safe for `new RegExp(...)`.
 */
export function escapeRegex(value) {
  return String(value).replace(REGEX_META, "\\$&");
}

/**
 * Builds a safe, case-insensitive RegExp from raw user input.
 *
 * Returns `null` when the input is empty after trimming, signalling the caller
 * to omit the search clause rather than match everything.
 *
 * @param {string} rawInput  - Untrusted user search string.
 * @param {object} [options]
 * @param {number} [options.maxLength=MAX_SEARCH_LENGTH] - Ceiling before truncation.
 * @returns {RegExp|null} Escaped RegExp or `null` if the input is blank.
 */
export function buildSafeSearchRegex(rawInput, { maxLength = MAX_SEARCH_LENGTH } = {}) {
  if (rawInput == null) return null;

  const trimmed = String(rawInput).trim();
  if (trimmed.length === 0) return null;

  const bounded = trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  return new RegExp(escapeRegex(bounded), "i");
}
