import Stripe from "stripe"
import Business from "../models/Business.js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000"

/**
 * POST /owner/stripe/connect-account
 *
 * Creates a Stripe Express connected account for the business (if not already
 * linked), then returns a single-use onboarding link.
 *
 * businessId is always taken from the authenticated session — never from the body.
 */
export async function connectAccount(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    // ── Create Express account if not already linked ──────────────────────────
    if (!business.stripeAccountId) {
      // TODO: remove MT fallback once all businesses have a country set
      const country = business.country?.trim() || "MT"

      const account = await stripe.accounts.create({
        type: "express",
        email: business.ownerEmail,
        country,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "company",
        metadata: {
          businessId: business.businessId,
          businessName: business.name,
        },
      })

      business.stripeAccountId = account.id
      await business.save()

      console.log(
        `[stripeConnect] Created Express account ${account.id} for businessId=${businessId}`
      )
    }

    // ── Create a fresh single-use onboarding link ─────────────────────────────
    const accountLink = await stripe.accountLinks.create({
      account: business.stripeAccountId,
      refresh_url: `${FRONTEND_URL}/owner/settings?tab=payments&refresh=true`,
      return_url: `${FRONTEND_URL}/owner/settings?tab=payments&success=true`,
      type: "account_onboarding",
    })

    return res.json({ onboardingUrl: accountLink.url })
  } catch (err) {
    console.error("[connectAccount] Error:", err)
    return res.status(500).json({ error: err.message || "Failed to create Stripe Connect account" })
  }
}

/**
 * GET /owner/stripe/status
 *
 * Retrieves the current status of the linked Stripe Express account and
 * syncs it back to the Business document.
 */
export async function getStripeStatus(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    // Not connected yet
    if (!business.stripeAccountId) {
      return res.json({
        connected: false,
        stripeAccountId: null,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeOnboardingComplete: false,
      })
    }

    // Retrieve live status from Stripe
    const account = await stripe.accounts.retrieve(business.stripeAccountId)

    const chargesEnabled = account.charges_enabled === true
    const payoutsEnabled = account.payouts_enabled === true
    const onboardingComplete = chargesEnabled && payoutsEnabled

    // Persist latest status
    business.stripeChargesEnabled = chargesEnabled
    business.stripePayoutsEnabled = payoutsEnabled
    business.stripeOnboardingComplete = onboardingComplete
    await business.save()

    console.log(
      `[stripeConnect] Status sync for ${businessId}: charges=${chargesEnabled}, payouts=${payoutsEnabled}`
    )

    return res.json({
      connected: true,
      stripeAccountId: business.stripeAccountId,
      stripeChargesEnabled: chargesEnabled,
      stripePayoutsEnabled: payoutsEnabled,
      stripeOnboardingComplete: onboardingComplete,
    })
  } catch (err) {
    console.error("[getStripeStatus] Error:", err)
    return res.status(500).json({ error: err.message || "Failed to retrieve Stripe status" })
  }
}

/**
 * GET /owner/stripe/dashboard-link
 *
 * Creates a single-use Stripe Express dashboard login link for the owner.
 * Only works once the account has completed onboarding (charges + payouts enabled).
 */
export async function getStripeDashboardLink(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    if (!business.stripeAccountId) {
      return res.status(400).json({ error: "No Stripe account linked to this business." })
    }

    if (!business.stripeChargesEnabled || !business.stripePayoutsEnabled) {
      return res.status(400).json({
        error: "Stripe account onboarding is not complete. Finish setup before accessing the dashboard.",
      })
    }

    const loginLink = await stripe.accounts.createLoginLink(business.stripeAccountId)

    console.log(
      `[getStripeDashboardLink] Login link created for businessId=${businessId}, accountId=${business.stripeAccountId}`
    )

    return res.json({ url: loginLink.url })
  } catch (err) {
    console.error("[getStripeDashboardLink] Error:", err)
    return res.status(500).json({ error: err.message || "Failed to create Stripe dashboard link" })
  }
}
