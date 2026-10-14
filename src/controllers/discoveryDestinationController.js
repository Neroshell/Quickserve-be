// Public destination suggestions are geographic predictions, never Chillow listings.
// Keep the Google credential on the server and fail closed when it is unconfigured.
const GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

export async function getDiscoveryDestinationSuggestions(req, res) {
  const input = typeof req.query?.input === "string" ? req.query.input.trim() : "";
  if (input.length < 2 || input.length > 100) {
    return res.status(400).json({ error: "Enter between 2 and 100 characters." });
  }
  // The canonical Google address service uses GOOGLE_PLACES_API_KEY.
  // Prefer the same server credential; preserve the older fallback for compatibility.
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim() || process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return res.status(503).json({ error: "Destination search is not configured." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const upstream = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({
        input,
        includedPrimaryTypes: ["(cities)"],
        languageCode: "en",
      }),
    });
    if (!upstream.ok) {
      let providerStatus = null;
      let providerCode = null;
      try {
        const payload = await upstream.json();
        providerStatus = typeof payload?.error?.status === "string" ? payload.error.status : null;
        providerCode = Number.isInteger(payload?.error?.code) ? payload.error.code : null;
      } catch {
        // Provider may return HTML or an invalid JSON body.
      }
      console.error("[discovery:destinations] Google Places autocomplete rejected request", {
        httpStatus: upstream.status,
        providerStatus,
        providerCode,
      });
      return res.status(502).json({ error: "Destination suggestions are temporarily unavailable." });
    }
    const data = await upstream.json();
    const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : [])
      .map((entry) => entry.placePrediction)
      .filter((entry) => typeof entry?.placeId === "string" && entry.placeId.length < 256)
      .slice(0, 8)
      .map((entry) => ({
        placeId: entry.placeId,
        label: String(entry.text?.text || "").slice(0, 180),
        name: String(entry.structuredFormat?.mainText?.text || "").slice(0, 120),
        subtitle: String(entry.structuredFormat?.secondaryText?.text || "").slice(0, 180),
      }))
      .filter((entry) => entry.label && entry.name);
    res.set("Cache-Control", "private, no-store");
    return res.json({ suggestions });
  } catch (error) {
    console.error("[discovery:destinations] Google Places autocomplete request failed", {
      failureType: error?.name === "AbortError" ? "timeout" : "network_or_invalid_response",
    });
    return res.status(502).json({ error: "Destination suggestions are temporarily unavailable." });
  } finally {
    clearTimeout(timeout);
  }
}
