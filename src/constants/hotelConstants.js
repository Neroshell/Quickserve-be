export const DEFAULT_HOTEL_ROOM_TYPES = [
    { name: "Standard", sortOrder: 1, active: true, isDefault: true },
    { name: "Superior", sortOrder: 2, active: true, isDefault: true },
    { name: "Deluxe", sortOrder: 3, active: true, isDefault: true },
    { name: "Executive", sortOrder: 4, active: true, isDefault: true },
    { name: "Junior Suite", sortOrder: 5, active: true, isDefault: true },
    { name: "Suite", sortOrder: 6, active: true, isDefault: true },
    { name: "Villa", sortOrder: 7, active: true, isDefault: true },
    { name: "Apartment", sortOrder: 8, active: true, isDefault: true },
]

export const HOTEL_PAYMENT_WINDOW_MINUTES = 30;

export function getHotelPaymentExpiresAt(now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  return new Date(timestamp + HOTEL_PAYMENT_WINDOW_MINUTES * 60 * 1000);
}
