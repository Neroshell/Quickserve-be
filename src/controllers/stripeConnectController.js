import Stripe from "stripe"
import Business from "../models/Business.js"
import { isCountryResolutionError, resolveCountryMetadata } from "../utils/countryHelper.js"

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
      let countryCode = business.countryCode
      if (!countryCode && business.country) {
        try {
          countryCode = resolveCountryMetadata(business.country).countryCode
        } catch (err) {
          if (isCountryResolutionError(err)) {
            return res.status(400).json({ error: err.message })
          }
          throw err
        }
      }

      if (!countryCode) {
        return res.status(400).json({ error: "Business country code is required before connecting Stripe." })
      }

      const account = await stripe.accounts.create({
        type: "express",
        email: business.ownerEmail,
        country: countryCode.toUpperCase(),
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
      refresh_url: `${FRONTEND_URL}/owner/billing?tab=payouts&refresh=true`,
      return_url: `${FRONTEND_URL}/owner/billing?tab=payouts`,
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

    return res.json({ url: loginLink.url })
  } catch (err) {
    console.error("[getStripeDashboardLink] Error:", err)
    return res.status(500).json({ error: err.message || "Failed to create Stripe dashboard link" })
  }
}
function sumBalanceByCurrency(rows = []) {
  const totals = new Map()

  for (const row of rows) {
    const currency = (row.currency || "eur").toUpperCase()
    totals.set(currency, (totals.get(currency) || 0) + (Number(row.amount) || 0))
  }

  return Array.from(totals.entries()).map(([currency, amount]) => ({
    currency,
    amount,
    amountMajor: amount / 100,
  }))
}

function formatStripePayout(payout) {
  return {
    id: payout.id,
    amount: payout.amount,
    amountMajor: (Number(payout.amount) || 0) / 100,
    currency: (payout.currency || "eur").toUpperCase(),
    status: payout.status,
    arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
    createdAt: payout.created ? new Date(payout.created * 1000) : null,
    method: payout.method || null,
    type: payout.type || null,
  }
}

/**
 * GET /owner/stripe/payout-summary
 *
 * Returns real Stripe Connect balance and payout information for the linked
 * Express account.
 */
export async function getPayoutSummary(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    }).lean()
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    if (!business.stripeAccountId) {
      return res.json({
        connected: false,
        payoutsEnabled: false,
        availableBalance: [],
        pendingBalance: [],
        nextPayout: null,
        recentPayouts: [],
      })
    }

    const [balance, payoutList] = await Promise.all([
      stripe.balance.retrieve({ stripeAccount: business.stripeAccountId }),
      stripe.payouts.list(
        { limit: 10 },
        { stripeAccount: business.stripeAccountId }
      ),
    ])

    const recentPayouts = payoutList.data.map(formatStripePayout)
    const nextPayout =
      recentPayouts.find((payout) => ["pending", "in_transit"].includes(payout.status)) || null

    return res.json({
      connected: true,
      payoutsEnabled: business.stripePayoutsEnabled === true,
      availableBalance: sumBalanceByCurrency(balance.available),
      pendingBalance: sumBalanceByCurrency(balance.pending),
      nextPayout,
      recentPayouts: recentPayouts.slice(0, 5),
    })
  } catch (err) {
    console.error("[getPayoutSummary] Error:", err)
    return res.status(500).json({ error: err.message || "Failed to retrieve payout summary" })
  }
}
