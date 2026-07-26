/**
 * Shared server-side rules added during restaurant-flow defect remediation.
 *
 * Keeping these checks in one module prevents guest, waiter, and Stripe checkout
 * paths from applying different quantity, availability, payment, or currency rules.
 * Client-supplied values are normalized only after validation, while business
 * configuration remains authoritative.
 */
const SERVABLE_BUSINESS_STATUSES = new Set([
  "active",
  "onboarding",
  "draft",
]);

function readBoolean(primary, fallback, defaultValue = true) {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

export function getOrderItemsValidationError(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "At least one item is required";
  }

  for (const item of items) {
    if (!item?.itemName || !String(item.itemName).trim()) {
      return "Each item must include an itemName";
    }

    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return `Item '${String(item.itemName).trim()}' quantity must be a positive whole number`;
    }
  }

  return null;
}

export function normalizeOrderItems(items) {
  return items.map((item) => ({
    ...item,
    itemName: String(item.itemName).trim(),
    quantity: Number(item.quantity),
  }));
}

export function isBusinessServable(business) {
  if (!business) return false;
  // Older records did not always persist status. Preserve their established
  // availability while enforcing every explicit terminal status.
  if (!business.status) return true;
  return SERVABLE_BUSINESS_STATUSES.has(business.status);
}

export function isOrderTypeEnabled(business, orderType) {
  if (orderType === "takeout") {
    return readBoolean(
      business?.orderingPreferences?.takeoutEnabled,
      business?.settings?.takeoutEnabled,
      false,
    );
  }

  return readBoolean(
    business?.orderingPreferences?.dineInEnabled,
    business?.settings?.dineInEnabled,
    true,
  );
}

export function isPaymentChannelEnabled(business, channel) {
  if (channel === "online") {
    return readBoolean(
      business?.paymentPreferences?.acceptOnlinePayments,
      business?.settings?.onlinePaymentEnabled,
      true,
    );
  }

  return readBoolean(
    business?.paymentPreferences?.acceptOfflinePayments,
    business?.settings?.offlinePaymentEnabled,
    true,
  );
}

export function isOfflinePaymentMethodEnabled(business, paidVia) {
  if (paidVia === "cash") {
    return readBoolean(
      business?.paymentPreferences?.acceptCash,
      business?.settings?.acceptCash,
      true,
    );
  }

  if (paidVia === "pos_card") {
    return readBoolean(
      business?.paymentPreferences?.acceptPosCard,
      business?.settings?.acceptPOS,
      true,
    );
  }

  return false;
}

export function getBusinessCurrency(business) {
  return String(business?.currency || "EUR").trim().toUpperCase();
}
