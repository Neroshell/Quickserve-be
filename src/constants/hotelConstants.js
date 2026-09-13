// Suggestions for owners creating a Room Type. These are not persisted as
// configured Room Types until an owner explicitly chooses and saves one.
export const HOTEL_ROOM_TYPE_NAME_SUGGESTIONS = Object.freeze([
    "Standard",
    "Superior",
    "Deluxe",
    "Executive",
    "Junior Suite",
    "Suite",
    "Villa",
    "Apartment",
])

export const HOTEL_PAYMENT_WINDOW_MINUTES = 30;

export function getHotelPaymentExpiresAt(now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  return new Date(timestamp + HOTEL_PAYMENT_WINDOW_MINUTES * 60 * 1000);
}
