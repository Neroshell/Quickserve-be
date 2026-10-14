export async function resolveDiscoveryDestination(placeId) {
  if (typeof placeId !== "string" || !/^[\w-]{5,255}$/.test(placeId)) {
    throw new Error("Invalid place ID");
  }
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("Google Places is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId), {
      signal: controller.signal,
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "id,types,addressComponents",
      },
    });
    if (!response.ok) throw new Error("Place resolution failed");
    const place = await response.json();
    const types = Array.isArray(place.types) ? place.types : [];
    const parts = Array.isArray(place.addressComponents) ? place.addressComponents : [];
    const part = (type) => parts.find((item) => item.types?.includes(type));
    const countryCode = part("country")?.shortText?.toLowerCase();
    if (!/^[a-z]{2}$/.test(countryCode || "")) throw new Error("Country missing");
    if (types.includes("country")) return { countryCode, city: null };
    if (!types.includes("locality") && !types.includes("postal_town")) {
      throw new Error("Unsupported geographic scope");
    }
    const city = part("locality")?.longText || part("postal_town")?.longText;
    if (typeof city !== "string" || !city || city.length > 120) throw new Error("City missing");
    return { countryCode, city };
  } finally {
    clearTimeout(timeout);
  }
}
