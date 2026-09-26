import Business from "../models/Business.js";

export const PUBLIC_SERVABLE_BUSINESS_STATUSES = Object.freeze([
  "active",
  "onboarding",
  "draft",
]);

export class PublicBusinessResolutionError extends Error {
  constructor(message, { statusCode = 400, code } = {}) {
    super(message);
    this.name = "PublicBusinessResolutionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizePublicBusinessLocator({ businessSlug, countryCode }) {
  const normalizedSlug = typeof businessSlug === "string"
    ? businessSlug.trim().toLowerCase()
    : "";
  if (!normalizedSlug) {
    throw new PublicBusinessResolutionError("businessSlug is required", {
      code: "PUBLIC_BUSINESS_SLUG_REQUIRED",
    });
  }

  const normalizedCountryCode = typeof countryCode === "string"
    ? countryCode.trim().toLowerCase()
    : "";
  if (!normalizedCountryCode) {
    throw new PublicBusinessResolutionError("countryCode is required", {
      code: "PUBLIC_BUSINESS_COUNTRY_REQUIRED",
    });
  }
  if (!/^[a-z]{2}$/.test(normalizedCountryCode)) {
    throw new PublicBusinessResolutionError(
      "countryCode must be a two-letter country code",
      { code: "PUBLIC_BUSINESS_COUNTRY_INVALID" },
    );
  }

  return {
    businessSlug: normalizedSlug,
    countryCode: normalizedCountryCode,
  };
}

async function lean(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

/**
 * Resolves the canonical public tenant identity.
 * Public requests always use the exact { countryCode, slug } pair.
 */
export async function resolvePublicBusiness({
  businessSlug,
  countryCode,
  statuses = null,
  businessModel = Business,
} = {}) {
  const locator = normalizePublicBusinessLocator({ businessSlug, countryCode });
  const baseQuery = {
    slug: locator.businessSlug,
    ...(Array.isArray(statuses) && statuses.length > 0
      ? { status: { $in: [...statuses] } }
      : {}),
  };

  const business = await lean(businessModel.findOne({
    ...baseQuery,
    countryCode: locator.countryCode,
  }));
  return { business: business || null, locator };
}
