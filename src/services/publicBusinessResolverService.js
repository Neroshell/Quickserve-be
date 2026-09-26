import Business from "../models/Business.js";

export const PUBLIC_SERVABLE_BUSINESS_STATUSES = Object.freeze([
  "active",
  "onboarding",
  "draft",
]);

export class PublicBusinessResolutionError extends Error {
  constructor(message, { statusCode = 400, code, candidates = [] } = {}) {
    super(message);
    this.name = "PublicBusinessResolutionError";
    this.statusCode = statusCode;
    this.code = code;
    this.candidates = candidates;
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
  if (normalizedCountryCode && !/^[a-z]{2}$/.test(normalizedCountryCode)) {
    throw new PublicBusinessResolutionError(
      "countryCode must be a two-letter country code",
      { code: "PUBLIC_BUSINESS_COUNTRY_INVALID" },
    );
  }

  return {
    businessSlug: normalizedSlug,
    countryCode: normalizedCountryCode || null,
  };
}

async function lean(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

/**
 * Resolves the canonical public tenant identity.
 *
 * Country-aware requests always use the exact { countryCode, slug } pair.
 * Slug-only requests are retained for legacy consumers only when the slug
 * identifies exactly one matching Business. Ambiguous legacy requests fail
 * closed rather than selecting an arbitrary tenant.
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

  if (locator.countryCode) {
    const business = await lean(businessModel.findOne({
      ...baseQuery,
      countryCode: locator.countryCode,
    }));
    return { business: business || null, locator, legacy: false };
  }

  // Legacy safety is based on global slug uniqueness, not only on the subset
  // currently allowed by the caller. A disabled duplicate must not turn an
  // otherwise ambiguous public identifier into a silently selectable tenant.
  let query = businessModel.find({ slug: locator.businessSlug });
  if (typeof query?.limit === "function") query = query.limit(2);
  const matches = (await lean(query)) || [];
  if (matches.length > 1) {
    throw new PublicBusinessResolutionError(
      "Multiple businesses use this slug. A countryCode is required.",
      {
        statusCode: 409,
        code: "AMBIGUOUS_PUBLIC_BUSINESS_SLUG",
        candidates: matches.map((business) => ({
          countryCode: business.countryCode || null,
          slug: business.slug,
        })),
      },
    );
  }

  const uniqueBusiness = matches[0] || null;
  const statusAllowed = !uniqueBusiness ||
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.includes(uniqueBusiness.status);

  return {
    business: statusAllowed ? uniqueBusiness : null,
    locator,
    legacy: true,
  };
}
