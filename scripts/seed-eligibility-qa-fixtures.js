/**
 * scripts/seed-eligibility-qa-fixtures.js
 *
 * Disposable local fixture seeder for Stage 3 browser QA.
 *
 * Creates or upserts three isolated test businesses in the local MongoDB
 * database so that each eligibility policy case can be exercised
 * independently via the browser without modifying any existing records.
 *
 * USAGE (local only):
 *   node scripts/seed-eligibility-qa-fixtures.js
 *
 * The script is non-destructive: it uses upsert on a stable businessId
 * so re-running it is idempotent. It does NOT affect any other record.
 *
 * FIXTURES
 * ─────────
 * A. qa-incomplete-onboarding  — active status, onboardingCompleted=false
 *    Expected: booking availability REJECTED (403 BUSINESS_ONBOARDING_INCOMPLETE)
 *
 * B. qa-suspended-business     — suspended status, onboardingCompleted=true
 *    Expected: booking availability REJECTED (403 BUSINESS_RESERVATIONS_UNAVAILABLE)
 *
 * C. qa-active-unpublished     — active + onboardingCompleted=true + discoveryPublished=false
 *    Expected: booking availability PERMITTED; absent from Discovery search/detail
 *
 * All fixtures:
 *   - are isolated to countryCode "mt" and QA-scoped slugs
 *   - carry no real email, Stripe, or payment data
 *   - can be removed with:  node scripts/seed-eligibility-qa-fixtures.js --teardown
 *
 * BOOKING URLS (Operations app default: http://localhost:3000)
 * ─────────────────────────────────────────────────────────────
 * A. http://localhost:3000/reserve/mt/qa-incomplete-onboarding
 * B. http://localhost:3000/reserve/mt/qa-suspended-business
 * C. http://localhost:3000/reserve/mt/qa-active-unpublished
 *
 * DISCOVERY URLS (Discovery app default: http://localhost:3001)
 * ─────────────────────────────────────────────────────────────
 * A. http://localhost:3001/en/places/mt/qa-incomplete-onboarding  (not visible)
 * B. http://localhost:3001/en/places/mt/qa-suspended-business     (not visible)
 * C. http://localhost:3001/en/places/mt/qa-active-unpublished     (not visible — unpublished)
 *    Search: http://localhost:3001/en/discover/results?category=eat
 *    (fixture C must NOT appear in results)
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

const TEARDOWN = process.argv.includes("--teardown");

const QA_FIXTURE_IDS = [
    "qa-biz-incomplete-onboarding",
    "qa-biz-suspended-business",
    "qa-biz-active-unpublished",
];

// ── Minimal Business schema inline so the script has no import side-effects ──
// Only the fields required by eligibility and discovery checks are included.
const BusinessSchema = new mongoose.Schema(
    {
        businessId: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        displayName: { type: String, required: true },
        slug: { type: String, required: true, lowercase: true, trim: true },
        address: { type: String, default: "1 QA Test Street" },
        country: { type: String, default: "Malta" },
        countryCode: { type: String, default: "mt" },
        businessType: { type: String, default: "restaurant" },
        modules: { type: [String], default: ["foodService"] },
        currency: { type: String, default: "EUR" },
        timezone: { type: String, default: "Europe/Malta" },
        status: {
            type: String,
            enum: ["draft", "active", "suspended", "archived"],
            default: "active",
        },
        onboardingCompleted: { type: Boolean, default: false },
        ownerEmail: { type: String, default: null, sparse: true },
        propertyProfile: {
            type: new mongoose.Schema({
                discoveryPublished: { type: Boolean, default: false },
                publishedAt: { type: Date, default: null },
                tagline: { type: String, default: "" },
                description: { type: String, default: "" },
                city: { type: String, default: "Valletta" },
                region: { type: String, default: "Malta" },
                photos: { type: Array, default: [] },
                facilityIds: { type: Array, default: [] },
                cuisineTypes: { type: Array, default: [] },
                mealServices: { type: Array, default: [] },
                atmosphere: { type: Array, default: [] },
                accessibility: { type: Array, default: [] },
                languages: { type: Array, default: ["en"] },
                socialLinks: {
                    instagram: { type: String, default: "" },
                    facebook: { type: String, default: "" },
                },
                parking: {
                    available: { type: Boolean, default: null },
                },
            }, { _id: false }),
            default: () => ({}),
        },
        reservationEligibilityVersion: { type: Number, default: 0 },
    },
    { timestamps: true, collection: "businesses" },
);

// ── Fixture definitions ───────────────────────────────────────────────────────

const fixtures = [
    {
        // A. Active + incomplete onboarding → booking rejected
        businessId: "qa-biz-incomplete-onboarding",
        name: "QA Incomplete Onboarding",
        displayName: "QA Incomplete Onboarding",
        slug: "qa-incomplete-onboarding",
        ownerEmail: "qa-incomplete-onboarding@chillow.test",
        status: "active",
        onboardingCompleted: false,
        propertyProfile: {
            discoveryPublished: false,
            city: "Valletta",
            description: "QA fixture only — do not use in production.",
            photos: [],
        },
        notes: "QA fixture A — active + incomplete onboarding. Safe to delete.",
    },
    {
        // B. Suspended + completed onboarding → booking rejected
        businessId: "qa-biz-suspended-business",
        name: "QA Suspended Business",
        displayName: "QA Suspended Business",
        slug: "qa-suspended-business",
        ownerEmail: "qa-suspended-business@chillow.test",
        status: "suspended",
        onboardingCompleted: true,
        propertyProfile: {
            discoveryPublished: false,
            city: "Sliema",
            description: "QA fixture only — do not use in production.",
            photos: [],
        },
        notes: "QA fixture B — suspended + onboarding complete. Safe to delete.",
    },
    {
        // C. Active + completed + unpublished → booking permitted; absent from Discovery
        businessId: "qa-biz-active-unpublished",
        name: "QA Active Unpublished",
        displayName: "QA Active Unpublished",
        slug: "qa-active-unpublished",
        ownerEmail: "qa-active-unpublished@chillow.test",
        status: "active",
        onboardingCompleted: true,
        propertyProfile: {
            discoveryPublished: false,
            publishedAt: null,
            city: "Valletta",
            description: "QA fixture only — do not use in production.",
            photos: [],
        },
        notes: "QA fixture C — active + complete + unpublished. Safe to delete.",
    },
];

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("MONGODB_URI is not set.");
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(uri);
    const Business = mongoose.models.Business || mongoose.model("Business", BusinessSchema);

    if (TEARDOWN) {
        const result = await Business.deleteMany({ businessId: { $in: QA_FIXTURE_IDS } });
        console.log(`[teardown] Removed ${result.deletedCount} QA fixture(s).`);
        await mongoose.disconnect();
        return;
    }

    for (const fixture of fixtures) {
        const { businessId, propertyProfile, ...rest } = fixture;

        // Use $set with dot-notation to preserve any extra nested fields that
        // might have been added by a previous run, and avoid clobbering the
        // entire propertyProfile sub-document.
        const update = {
            $set: {
                ...rest,
                "propertyProfile.discoveryPublished": propertyProfile.discoveryPublished,
                "propertyProfile.city": propertyProfile.city,
                "propertyProfile.description": propertyProfile.description,
                "propertyProfile.photos": propertyProfile.photos,
            },
        };

        if (propertyProfile.publishedAt !== undefined) {
            update.$set["propertyProfile.publishedAt"] = propertyProfile.publishedAt;
        }

        const doc = await Business.findOneAndUpdate(
            { businessId },
            update,
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        console.log(`[upsert] ${businessId} → status=${doc.status}, onboardingCompleted=${doc.onboardingCompleted}, discoveryPublished=${doc.propertyProfile?.discoveryPublished}`);
    }

    console.log(`
QA Fixtures ready.

─────────────────────────────────────────────────────────────────────
FIXTURE   SLUG                          STATUS     ONBOARDING  PUBLISHED
A         qa-incomplete-onboarding      active     false       false
B         qa-suspended-business         suspended  true        false
C         qa-active-unpublished         active     true        false
─────────────────────────────────────────────────────────────────────

ELIGIBILITY POLICY EXPECTATIONS
  A → booking REJECTED  (403 BUSINESS_ONBOARDING_INCOMPLETE)
  B → booking REJECTED  (403 BUSINESS_RESERVATIONS_UNAVAILABLE)
  C → booking PERMITTED; absent from Discovery search and detail

OPERATIONS BOOKING URLS  (default: http://localhost:3000)
  A  http://localhost:3000/reserve/mt/qa-incomplete-onboarding
  B  http://localhost:3000/reserve/mt/qa-suspended-business
  C  http://localhost:3000/reserve/mt/qa-active-unpublished

DISCOVERY URLS  (default: http://localhost:3001)
  A  http://localhost:3001/en/places/mt/qa-incomplete-onboarding  (should 404)
  B  http://localhost:3001/en/places/mt/qa-suspended-business     (should 404)
  C  http://localhost:3001/en/places/mt/qa-active-unpublished     (should 404)
  Search: http://localhost:3001/en/discover/results?category=eat  (C absent)

Remove fixtures:  node scripts/seed-eligibility-qa-fixtures.js --teardown
`);

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
