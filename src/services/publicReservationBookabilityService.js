import { resolveBusinessCapabilities } from "./businessCapabilityService.js";
import { getReservationEligibility } from "./reservationEligibilityService.js";

export const PUBLIC_RESERVATION_MODES = Object.freeze(["stay", "timeslot"]);

function configuredPublicModes(business, capabilities) {
  const value = business?.settings?.publicReservationModes;

  // The missing-field branch is intentional compatibility behavior: existing
  // businesses continue to expose only their established primary workflow.
  if (value === undefined) {
    return capabilities?.reservations?.primaryMode
      ? [capabilities.reservations.primaryMode]
      : [];
  }

  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((mode) => PUBLIC_RESERVATION_MODES.includes(mode)))];
}

/**
 * Resolves persisted public-mode configuration without the public eligibility
 * fence. Owner setup guidance uses this to explain configuration separately
 * from the final active/onboarding booking gate.
 */
export function getConfiguredPublicReservationModes(business) {
  const capabilities = resolveBusinessCapabilities(business);
  const supportedModes = capabilities?.reservations?.modes || [];

  return configuredPublicModes(business, capabilities)
    .filter((mode) => supportedModes.includes(mode));
}

/**
 * Resolves only reservation modes that a guest may start. Dynamic inventory
 * and slot checks remain in the established mode-specific availability and
 * creation services, which revalidate every request.
 */
export function getPublicReservationBookability(business) {
  const eligibility = getReservationEligibility(business);
  const capabilities = resolveBusinessCapabilities(business);

  if (!eligibility.eligible || business?.settings?.reservationsEnabled === false) {
    return { modes: [], primaryMode: capabilities?.reservations?.primaryMode || null };
  }

  const modes = getConfiguredPublicReservationModes(business);

  return {
    modes,
    primaryMode: capabilities?.reservations?.primaryMode || null,
  };
}

export function assertPublicReservationModeBookable(business, mode) {
  if (!PUBLIC_RESERVATION_MODES.includes(mode)) {
    const error = new Error("reservationMode must be stay or timeslot");
    error.statusCode = 400;
    throw error;
  }

  const bookability = getPublicReservationBookability(business);
  if (!bookability.modes.includes(mode)) {
    const error = new Error("Reservations are not available for this booking experience.");
    error.statusCode = 404;
    error.code = "PUBLIC_RESERVATION_MODE_UNAVAILABLE";
    throw error;
  }
  return mode;
}

export function resolvePublicReservationMode({
  business,
  reservationMode,
  isHotelBooking,
  hasStayFields = false,
  hasTimeslotFields = false,
} = {}) {
  if (isHotelBooking !== undefined && isHotelBooking !== null && typeof isHotelBooking !== "boolean") {
    const error = new Error("isHotelBooking must be a boolean when provided.");
    error.statusCode = 400;
    throw error;
  }
  if (hasStayFields && hasTimeslotFields) {
    const error = new Error("Reservation payload cannot combine stay and dining fields.");
    error.statusCode = 400;
    throw error;
  }

  const explicitMode = reservationMode === undefined || reservationMode === null || reservationMode === ""
    ? null
    : reservationMode;
  if (explicitMode !== null && !PUBLIC_RESERVATION_MODES.includes(explicitMode)) {
    const error = new Error("reservationMode must be stay or timeslot");
    error.statusCode = 400;
    throw error;
  }

  const legacyMode = typeof isHotelBooking === "boolean"
    ? (isHotelBooking ? "stay" : "timeslot")
    : null;
  if (explicitMode && legacyMode && explicitMode !== legacyMode) {
    const error = new Error("reservationMode conflicts with isHotelBooking.");
    error.statusCode = 400;
    throw error;
  }

  const payloadMode = hasStayFields ? "stay" : hasTimeslotFields ? "timeslot" : null;
  if (explicitMode && payloadMode && explicitMode !== payloadMode) {
    const error = new Error("reservationMode conflicts with the reservation payload.");
    error.statusCode = 400;
    throw error;
  }
  if (legacyMode && payloadMode && legacyMode !== payloadMode) {
    const error = new Error("isHotelBooking conflicts with the reservation payload.");
    error.statusCode = 400;
    throw error;
  }

  const mode = explicitMode || legacyMode || payloadMode ||
    getPublicReservationBookability(business).primaryMode;
  return assertPublicReservationModeBookable(business, mode);
}
