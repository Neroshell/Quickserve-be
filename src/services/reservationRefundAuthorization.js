const RESERVATION_REFUND_ROLES = new Set(["owner", "co_owner"]);

/**
 * Temporary, default-deny financial authority boundary. A future explicit
 * `reservation.refund` permission can replace this role check without changing
 * the cancellation/refund domain service.
 */
export function canRefundReservation(user) {
  return Boolean(user?.role && RESERVATION_REFUND_ROLES.has(user.role));
}

export function getReservationRefundRoles() {
  return [...RESERVATION_REFUND_ROLES];
}
