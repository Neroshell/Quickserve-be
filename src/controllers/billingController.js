import Stripe from "stripe"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import Order from "../models/order.js"
import BillingInvoice from "../models/BillingInvoice.js"
import { getPlanOfflineCommissionRate } from "../utils/platformFee.js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/** Resolve businessId from request */
function resolveBusinessId(req) {
    if (req.session?.user?.businessId) return req.session.user.businessId
    if (req.user?.businessId) return req.user.businessId
    return null
}

const DAY_MS = 24 * 60 * 60 * 1000

function addMonths(date, months) {
    const next = new Date(date)
    const day = next.getDate()
    next.setDate(1)
    next.setMonth(next.getMonth() + months)
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
    next.setDate(Math.min(day, lastDay))
    return next
}

function toBillingPeriod(start, invoiceAt) {
    return {
        start,
        end: new Date(invoiceAt.getTime() - 1),
        invoiceAt,
        daysUntilInvoice: Math.max(0, Math.ceil((invoiceAt.getTime() - Date.now()) / DAY_MS)),
    }
}

function getSubscriptionPeriodFromStripe(subscription) {
    if (!subscription?.current_period_start || !subscription?.current_period_end) return null

    const start = new Date(subscription.current_period_start * 1000)
    const invoiceAt = new Date(subscription.current_period_end * 1000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(invoiceAt.getTime())) return null

    return toBillingPeriod(start, invoiceAt)
}

function getStoredBillingPeriod(biz) {
    const start = biz.currentPeriodStart ? new Date(biz.currentPeriodStart) : null
    const invoiceAt = biz.nextInvoiceDate ? new Date(biz.nextInvoiceDate) : (biz.nextBillingDate ? new Date(biz.nextBillingDate) : null)
    if (!start || !invoiceAt || Number.isNaN(start.getTime()) || Number.isNaN(invoiceAt.getTime())) return null
    return toBillingPeriod(start, invoiceAt)
}

function getAnniversaryBillingPeriod(biz, now = new Date()) {
    let start = biz.planActivatedAt ? new Date(biz.planActivatedAt) : (biz.createdAt ? new Date(biz.createdAt) : new Date(now))
    if (Number.isNaN(start.getTime())) start = new Date(now)

    while (addMonths(start, 1) <= now) {
        start = addMonths(start, 1)
    }

    return toBillingPeriod(start, addMonths(start, 1))
}

async function getCurrentBillingPeriod(biz, { persist = true } = {}) {
    if (biz.stripeSubscriptionId) {
        try {
            const subscription = await stripe.subscriptions.retrieve(biz.stripeSubscriptionId)
            const period = getSubscriptionPeriodFromStripe(subscription)

            if (period) {
                if (persist) {
                    await Business.updateOne(
                        { businessId: biz.businessId },
                        {
                            $set: {
                                currentPeriodStart: period.start,
                                currentPeriodEnd: period.end,
                                nextInvoiceDate: period.invoiceAt,
                                nextBillingDate: period.invoiceAt,
                                stripeSubscriptionStatus: subscription.status,
                            }
                        }
                    )
                }
                return period
            }
        } catch (err) {
            console.warn(`[billingPeriod] Failed to sync Stripe subscription ${biz.stripeSubscriptionId}:`, err.message)
        }
    }

    const storedPeriod = getStoredBillingPeriod(biz)
    if (storedPeriod && storedPeriod.invoiceAt > new Date()) return storedPeriod

    return getAnniversaryBillingPeriod(biz)
}

function getOfflineFeeBreakdown(orders, commissionMultiplier) {
    let grossCents = 0
    let customerPaidFeesCents = 0
    let businessPaidFeesCents = 0
    let totalFeeCents = 0

    for (const order of orders) {
        const subtotal = order.subtotal || 0
        const taxAmount = order.taxAmount || 0
        grossCents += Math.round((subtotal + taxAmount) * 100)

        let orderFeeCents = 0
        let orderCustomerPaidCents = 0
        let orderBusinessPaidCents = 0

        if (order.commissionAmountCents != null) {
            orderFeeCents = order.commissionAmountCents
        } else if (order.platformFeeTotal > 0) {
            orderFeeCents = Math.round(order.platformFeeTotal * 100)
        } else {
            orderFeeCents = Math.round(subtotal * 100 * commissionMultiplier)
        }

        if (order.platformFeeCents != null && order.platformFeeCents > 0) {
            orderCustomerPaidCents = order.customerPlatformFeeCents || 0
            orderBusinessPaidCents = order.businessAbsorbedPlatformFeeCents || 0
        } else if (order.platformFeeTotal > 0) {
            orderCustomerPaidCents = orderFeeCents
        } else {
            orderBusinessPaidCents = orderFeeCents
        }

        customerPaidFeesCents += orderCustomerPaidCents
        businessPaidFeesCents += orderBusinessPaidCents
        totalFeeCents += orderFeeCents
    }

    return {
        gross: grossCents / 100,
        customerPaidFees: customerPaidFeesCents / 100,
        businessPaidFees: businessPaidFeesCents / 100,
        totalQuickServeFees: totalFeeCents / 100,
    }
}

function paidInPeriodQuery(period) {








































































































































































































































































































































































































































    
    return {
        $or: [
            { paidAt: { $gte: period.start, $lt: period.invoiceAt } },
            {
                $and: [
                    { $or: [{ paidAt: null }, { paidAt: { $exists: false } }] },
                    { createdAt: { $gte: period.start, $lt: period.invoiceAt } },
                ]
            }
        ]
    }
}

async function getRevenueSummary(businessId) {
    const rows = await Order.aggregate([
        {
            $match: {
                businessId,
                paymentStatus: "paid",
                paymentChannel: { $in: ["online", "offline"] },
                status: { $ne: "cancelled" },
            },
        },
        {
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          
            $group: {
                _id: "$paymentChannel",
                revenue: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ["$total", 0] },
                            { $ifNull: ["$tipAmount", 0] }
                        ]
                    }
                },
                tips: { $sum: { $ifNull: ["$tipAmount", 0] } },
                orders: { $sum: 1 },
                fees: {
                    $sum: {
                        $ifNull: [
                            { $divide: ["$commissionAmountCents", 100] },
                            { $ifNull: ["$platformFeeTotal", 0] }
                        ]
                    }
                }
            },
        },
    ])

    const summary = {
        onlineRevenueProcessed: 0,
        offlineRevenueProcessed: 0,
        totalOrdersProcessed: 0,
        totalQuickServeFeesProcessed: 0,
        totalTipsProcessed: 0,
    }

    for (const row of rows) {
        if (row._id === "online") summary.onlineRevenueProcessed = row.revenue || 0
        if (row._id === "offline") summary.offlineRevenueProcessed = row.revenue || 0
        summary.totalOrdersProcessed += row.orders || 0
        summary.totalQuickServeFeesProcessed += row.fees || 0
        summary.totalTipsProcessed += row.tips || 0
    }

    const totalRevenueProcessed = summary.onlineRevenueProcessed + summary.offlineRevenueProcessed
    const netRevenueProcessed = totalRevenueProcessed - summary.totalQuickServeFeesProcessed

    return {
        ...summary,
        totalRevenueProcessed,
        netRevenueProcessed,
        averageOrderValue: summary.totalOrdersProcessed > 0
            ? totalRevenueProcessed / summary.totalOrdersProcessed
            : 0,
        label: "Since joining QuickServe",
    }
}

/**
 * GET /owner/billing
 * Returns the current billing status, plan info, and safe payment method metadata.
 */
export async function getBillingOverview(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) return res.status(404).json({ message: "Business not found" })

        const billingPeriod = await getCurrentBillingPeriod(biz)

        res.json({
            billingStatus: biz.billingStatus || 'incomplete',
            billingEnabled: biz.billingEnabled || false,
            currentPlan: biz.currentPlan || 'basic',
            planActivatedAt: biz.planActivatedAt || null,
            billingCycle: biz.billingCycle || 'monthly',
            currentPeriodStart: billingPeriod.start,
            currentPeriodEnd: billingPeriod.end,
            nextInvoiceDate: billingPeriod.invoiceAt,
            nextBillingDate: billingPeriod.invoiceAt,
            billingPeriod,
            daysUntilInvoice: billingPeriod.daysUntilInvoice,
            paymentMethodBrand: biz.paymentMethodBrand || null,
            paymentMethodLast4: biz.paymentMethodLast4 || null,
            paymentMethodExpMonth: biz.paymentMethodExpMonth || null,
            paymentMethodExpYear: biz.paymentMethodExpYear || null,
            scheduledDowngradePlan: biz.scheduledDowngradePlan || null,
            scheduledPlanEffectiveDate: biz.scheduledPlanEffectiveDate || null
        })
    } catch (err) {
        console.error("[getBillingOverview] Error:", err)
        res.status(500).json({ message: "Server error" })
    }
}

/**
 * POST /owner/billing/setup-intent
 * Creates a Stripe SetupIntent and returns clientSecret for frontend Stripe Elements.
 */
export async function createSetupIntent(req, res) {
    try {
        console.log("STRIPE KEY EXISTS:", !!process.env.STRIPE_SECRET_KEY)
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        let biz = await Business.findOne({ businessId })
        if (!biz) return res.status(404).json({ message: "Business not found" })

        // Create a Stripe Customer if one doesn't exist
        let customerId = biz.stripeCustomerId
        if (!customerId) {
            const customer = await stripe.customers.create({
                metadata: { businessId },
                email: biz.ownerEmail || biz.contactEmail || undefined,
                name: biz.name || undefined
            })
            customerId = customer.id
            biz.stripeCustomerId = customerId
            await biz.save()
        }

        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ["card"],
            usage: "off_session",
            metadata: {
                businessId: biz.businessId,
                purpose: "quickserve_billing_card",
            },
        })

        res.json({ clientSecret: setupIntent.client_secret })
    } catch (err) {
        console.error("[createSetupIntent] Error:", err)
        res.status(500).json({ message: err.message || "Server error creating setup intent" })
    }
}

/**
 * POST /owner/billing/verify-payment-method
 * Called by the frontend after Stripe Elements confirms the SetupIntent.
 * Retrieves the SetupIntent by ID, validates it, saves safe card metadata.
 */
export async function verifyPaymentMethod(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const { setupIntentId } = req.body
        if (!setupIntentId) return res.status(400).json({ message: "Missing setupIntentId" })

        const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)

        if (setupIntent.status !== "succeeded") {
            return res.status(400).json({ message: `SetupIntent status is "${setupIntent.status}", expected "succeeded"` })
        }

        if (!setupIntent.payment_method) {
            return res.status(400).json({ message: "No payment method attached to SetupIntent" })
        }

        const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method)

        // Set as customer default payment method
        if (setupIntent.customer) {
            await stripe.customers.update(setupIntent.customer, {
                invoice_settings: {
                    default_payment_method: paymentMethod.id
                }
            })
        }

        // Save safe display metadata to our database
        const biz = await Business.findOneAndUpdate(
            { businessId },
            {
                billingStatus: 'active',
                billingEnabled: true,
                defaultPaymentMethodId: paymentMethod.id,
                paymentMethodBrand: paymentMethod.card?.brand,
                paymentMethodLast4: paymentMethod.card?.last4,
                paymentMethodExpMonth: paymentMethod.card?.exp_month,
                paymentMethodExpYear: paymentMethod.card?.exp_year,
            },
            { new: true }
        ).lean()

        const verifyPaymentMethodBillingPeriod = await getCurrentBillingPeriod(biz)

        // Return the updated billing overview
        res.json({
            billingStatus: biz.billingStatus || 'incomplete',
            billingEnabled: biz.billingEnabled || false,
            currentPlan: biz.currentPlan === 'enterprise' ? 'pro' : (biz.currentPlan || 'basic'),
            planActivatedAt: biz.planActivatedAt || null,
            billingCycle: biz.billingCycle || 'monthly',
            currentPeriodStart: verifyPaymentMethodBillingPeriod.start,
            currentPeriodEnd: verifyPaymentMethodBillingPeriod.end,
            nextInvoiceDate: verifyPaymentMethodBillingPeriod.invoiceAt,
            nextBillingDate: verifyPaymentMethodBillingPeriod.invoiceAt,
            billingPeriod: verifyPaymentMethodBillingPeriod,
            daysUntilInvoice: verifyPaymentMethodBillingPeriod.daysUntilInvoice,
            paymentMethodBrand: biz.paymentMethodBrand || null,
            paymentMethodLast4: biz.paymentMethodLast4 || null,
            paymentMethodExpMonth: biz.paymentMethodExpMonth || null,
            paymentMethodExpYear: biz.paymentMethodExpYear || null,
            scheduledDowngradePlan: biz.scheduledDowngradePlan || null,
            scheduledPlanEffectiveDate: biz.scheduledPlanEffectiveDate || null
        })
    } catch (err) {
        console.error("[verifyPaymentMethod] Error:", err)
        res.status(500).json({ message: "Server error verifying payment method" })
    }
}

/**
 * DELETE /owner/billing/payment-method
 * Detaches the stored payment method from Stripe and clears card metadata.
 */
export async function deletePaymentMethod(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const biz = await Business.findOne({ businessId })
        if (!biz) return res.status(404).json({ message: "Business not found" })

        if (!biz.defaultPaymentMethodId) {
            return res.status(400).json({ message: "No payment method on file to remove." })
        }

        // Detach the payment method from the Stripe customer
        try {
            await stripe.paymentMethods.detach(biz.defaultPaymentMethodId)
        } catch (stripeErr) {
            // If the PM was already deleted on Stripe's side, log and continue
            console.warn("[deletePaymentMethod] Stripe detach warning:", stripeErr.message)
        }

        // Clear the default on the Stripe customer object
        if (biz.stripeCustomerId) {
            try {
                await stripe.customers.update(biz.stripeCustomerId, {
                    invoice_settings: { default_payment_method: null }
                })
            } catch (stripeErr) {
                console.warn("[deletePaymentMethod] Stripe customer update warning:", stripeErr.message)
            }
        }

        // Clear card metadata from our database
        biz.defaultPaymentMethodId = undefined
        biz.paymentMethodBrand = undefined
        biz.paymentMethodLast4 = undefined
        biz.paymentMethodExpMonth = undefined
        biz.paymentMethodExpYear = undefined
        biz.billingStatus = "incomplete"
        biz.billingEnabled = false
        await biz.save()

        res.json({
            message: "Payment method removed successfully.",
            billingStatus: "incomplete",
            billingEnabled: false,
            paymentMethodBrand: null,
            paymentMethodLast4: null,
            paymentMethodExpMonth: null,
            paymentMethodExpYear: null
        })
    } catch (err) {
        console.error("[deletePaymentMethod] Error:", err)
        res.status(500).json({ message: "Server error removing payment method" })
    }
}

/**
 * POST /owner/billing/plan
 *
 * Orchestrates an actual Stripe Subscription when an owner selects or changes a plan.
 *
 * Rules:
 *  - Upgrades: applied immediately with proration (owner billed prorated difference now).
 *  - Downgrades: scheduled for end of current billing period via Stripe Schedule.
 *  - Stripe is ALWAYS updated first. DB only changes if Stripe succeeds.
 *  - Free-tier (Basic) has no base price item, only a metered commission item.
 */
export async function updatePlan(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const { planSlug } = req.body
        const VALID_PLANS = ['basic', 'growth', 'pro']
        if (!VALID_PLANS.includes(planSlug)) {
            return res.status(400).json({ message: "Invalid plan selection" })
        }

        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) return res.status(404).json({ message: "Business not found" })

        if (!biz.stripeCustomerId) {
            return res.status(400).json({
                code: "NO_STRIPE_CUSTOMER",
                message: "Billing setup incomplete. Please add a payment method first."
            })
        }

        if (biz.currentPlan === planSlug && !biz.scheduledDowngradePlan) {
            return res.status(400).json({ message: "You are already on this plan." })
        }

        const targetPlan = await Plan.findOne({ slug: planSlug }).lean()
        if (!targetPlan) {
            return res.status(404).json({ message: `Plan '${planSlug}' not found in database.` })
        }
        if (!targetPlan.stripeMeteredPriceId) {
            return res.status(500).json({
                code: "PLAN_CONFIGURATION_ERROR",
                message: "This subscription plan is not fully configured."
            })
        }

        const currentPlan = await Plan.findOne({ slug: biz.currentPlan || 'basic' }).lean()
        if (targetPlan.level === currentPlan?.level) {
             return res.status(400).json({ message: "You are already on this plan." })
        }
        const isUpgrade = targetPlan.level > (currentPlan?.level || 1)

        let stripeSubscriptionId = biz.stripeSubscriptionId
        let stripeMeteredSubscriptionItemId = biz.stripeMeteredSubscriptionItemId
        let scheduledDowngradePlan = null
        let effectivePlan = planSlug
        let downgradeScheduled = false
        let activeSubscription = null

        if (!stripeSubscriptionId) {
            const items = buildSubscriptionItems(targetPlan)
            const subscription = await stripe.subscriptions.create({
                customer: biz.stripeCustomerId,
                items,
                collection_method: 'charge_automatically',
                payment_settings: {
                    payment_method_types: ['card'],
                    save_default_payment_method: 'on_subscription'
                },
                metadata: {
                    businessId,
                    planSlug
                }
            })

            activeSubscription = subscription
            stripeSubscriptionId = subscription.id
            stripeMeteredSubscriptionItemId = findMeteredItemId(subscription, targetPlan.stripeMeteredPriceId)
        } else {
            const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)
            activeSubscription = subscription

            if (isUpgrade) {
                const items = buildSubscriptionUpdateItems(subscription, targetPlan)
                const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
                    items,
                    proration_behavior: 'create_prorations',
                    metadata: {
                        businessId,
                        planSlug
                    }
                })

                activeSubscription = updated
                stripeMeteredSubscriptionItemId = findMeteredItemId(updated, targetPlan.stripeMeteredPriceId)
            } else {
                downgradeScheduled = true
                effectivePlan = biz.currentPlan || 'basic'
                scheduledDowngradePlan = planSlug
            }
        }

        let subscriptionPeriod = activeSubscription ? getSubscriptionPeriodFromStripe(activeSubscription) : null
        if (!subscriptionPeriod) {
            subscriptionPeriod = await getCurrentBillingPeriod(biz, { persist: false })
        }

        const scheduledPlanEffectiveDate = downgradeScheduled ? subscriptionPeriod.invoiceAt : null

        await Business.findOneAndUpdate(
            { businessId },
            {
                $set: {
                    currentPlan: effectivePlan,
                    plan: effectivePlan,
                    planActivatedAt: downgradeScheduled ? biz.planActivatedAt : new Date(),
                    stripeSubscriptionId,
                    stripeMeteredSubscriptionItemId,
                    scheduledDowngradePlan,
                    scheduledPlanEffectiveDate,
                    currentPeriodStart: subscriptionPeriod.start,
                    currentPeriodEnd: subscriptionPeriod.end,
                    nextInvoiceDate: subscriptionPeriod.invoiceAt,
                    nextBillingDate: subscriptionPeriod.invoiceAt,
                    billingStatus: 'active',
                    billingEnabled: true,
                }
            },
            { new: true }
        )

        const responseMessage = downgradeScheduled
            ? `Downgrade to ${planSlug} scheduled for ${subscriptionPeriod.invoiceAt.toISOString()}.`
            : `Successfully switched to ${planSlug} plan.`

        res.json({
            success: true,
            currentPlan: effectivePlan,
            scheduledDowngradePlan: scheduledDowngradePlan ?? null,
            scheduledPlanEffectiveDate,
            stripeMeteredSubscriptionItemId,
            currentPeriodStart: subscriptionPeriod.start,
            currentPeriodEnd: subscriptionPeriod.end,
            nextInvoiceDate: subscriptionPeriod.invoiceAt,
            nextBillingDate: subscriptionPeriod.invoiceAt,
            message: responseMessage,
        })
    } catch (err) {
        console.error("[updatePlan] Error:", err?.message || err)
        if (err?.type) console.error("[updatePlan] Stripe error type:", err.type, "code:", err?.code, "statusCode:", err?.statusCode)
        const stripeCode = err?.raw?.code || err?.code
        if (stripeCode === "resource_missing") {
            return res.status(400).json({ message: "Stripe subscription or price not found. Please check your plan configuration." })
        }
        if (stripeCode === "customer_deleted") {
            return res.status(400).json({ message: "Stripe customer was deleted. Please re-add your payment method." })
        }
        // Pass through Stripe's own message when available for better debugging
        const userMessage = err?.raw?.message || err?.message || "Server error updating plan"
        res.status(500).json({ message: userMessage })
    }
}

// --- Stripe Subscription Helpers ---

function buildSubscriptionItems(plan) {
    const items = []
    if (plan.stripeBasePriceId) {
        items.push({ price: plan.stripeBasePriceId })
    }
    if (plan.stripeMeteredPriceId) {
        items.push({ price: plan.stripeMeteredPriceId })
    }
    return items
}

function buildSubscriptionUpdateItems(subscription, plan) {
    const items = []
    const existingItems = subscription?.items?.data || []

    // Separate existing items by type (base = recurring, metered = metered)
    const existingBase = existingItems.find(i => i.price.type === 'recurring' && i.price.recurring?.usage_type !== 'metered')
    const existingMetered = existingItems.find(i => i.price.recurring?.usage_type === 'metered')

    // Handle base price: swap in-place if exists, add if new, delete if no longer needed
    if (plan.stripeBasePriceId) {
        if (existingBase) {
            items.push({ id: existingBase.id, price: plan.stripeBasePriceId })
        } else {
            items.push({ price: plan.stripeBasePriceId })
        }
    } else if (existingBase) {
        // New plan has no base price (e.g. free tier), delete the old one
        items.push({ id: existingBase.id, deleted: true })
    }

    // Handle metered price: swap in-place if exists, add if new
    if (plan.stripeMeteredPriceId) {
        if (existingMetered) {
            items.push({ id: existingMetered.id, price: plan.stripeMeteredPriceId })
        } else {
            items.push({ price: plan.stripeMeteredPriceId })
        }
    } else if (existingMetered) {
        items.push({ id: existingMetered.id, deleted: true })
    }

    // Clean up any other items that don't match base or metered
    existingItems.forEach(item => {
        if (item !== existingBase && item !== existingMetered) {
            items.push({ id: item.id, deleted: true })
        }
    })

    return items
}

function findMeteredItemId(subscription, priceId) {
    if (!subscription || !subscription.items || !subscription.items.data) return null
    const item = subscription.items.data.find(i => i.price.id === priceId)
    return item ? item.id : null
}
/**
 * GET /owner/billing/commission
 *
 * Returns a breakdown of offline commission:
 *  - reported: already sent to Stripe (done)
 *  - pending:  paid offline orders not yet reported to Stripe (open balance)
 *
 * Only unreported orders are counted as pending to prevent unbounded accumulation.
 */
export async function getCommissionSummary(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) return res.status(404).json({ message: "Business not found" })

        const currentPlan = biz.currentPlan || 'basic'
        const currentPlanDoc = await Plan.findOne({ slug: currentPlan }).lean()
        const subscriptionFee = Number(currentPlanDoc?.monthlyPrice || 0)
        const offlineCommissionRate = await getPlanOfflineCommissionRate(currentPlan)
        const commissionMultiplier = offlineCommissionRate / 100
        const billingPeriod = await getCurrentBillingPeriod(biz)

        const billableOfflineQuery = {
            businessId,
            paymentChannel: 'offline',
            paymentStatus: 'paid',
            status: { $ne: 'cancelled' },
        }
        const unreportedOfflineQuery = {
            ...billableOfflineQuery,
            commissionReportedToStripe: false,
        }

        const periodPaymentQuery = paidInPeriodQuery(billingPeriod)

        const [pendingOrders, currentCycleOrders, allOfflineOrders, revenueSummary] = await Promise.all([
            Order.find({ ...unreportedOfflineQuery, ...periodPaymentQuery }).lean(),
            Order.find({ ...billableOfflineQuery, ...periodPaymentQuery }).lean(),
            Order.find({
                businessId,
                paymentChannel: 'offline',
                paymentStatus: 'paid',
                status: { $ne: 'cancelled' },
            }).lean(),
            getRevenueSummary(businessId),
        ])

        const pendingBreakdown = getOfflineFeeBreakdown(pendingOrders, commissionMultiplier)
        const currentBreakdown = getOfflineFeeBreakdown(currentCycleOrders, commissionMultiplier)
        const allOfflineBreakdown = getOfflineFeeBreakdown(allOfflineOrders, commissionMultiplier)

        res.json({
            currentPlan,
            offlineCommissionRate,
            totalGross: allOfflineBreakdown.gross,
            customerPaidFees: allOfflineBreakdown.customerPaidFees,
            businessOwedCommission: allOfflineBreakdown.businessPaidFees,
            totalCommission: allOfflineBreakdown.totalQuickServeFees,
            pendingCommission: currentBreakdown.totalQuickServeFees,
            pendingOrderCount: currentCycleOrders.length,
            billingReady: !!biz.stripeMeteredSubscriptionItemId,
            billingPeriod,
            daysUntilInvoice: billingPeriod.daysUntilInvoice,
            currentBillingCycle: {
                billingPeriod,
                customerPaidFees: currentBreakdown.customerPaidFees,
                businessPaidFees: currentBreakdown.businessPaidFees,
                totalQuickServeFees: currentBreakdown.totalQuickServeFees,
                subscriptionFee,
                offlineCommissionAmount: currentBreakdown.totalQuickServeFees,
                pendingInvoiceAmount: subscriptionFee + currentBreakdown.totalQuickServeFees,
                pendingOrderCount: currentCycleOrders.length,
            },
            revenueSummary,
        })
    } catch (err) {
        console.error("[getCommissionSummary] Error:", err)
        res.status(500).json({ message: "Server error aggregating commission" })
    }
}

/**
 * GET /owner/billing/invoices
 * Queries the internal BillingInvoice collection.
 */
export async function getInvoices(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const dbInvoices = await BillingInvoice.find({ businessId }).sort({ createdAt: -1 }).lean()

        const invoices = await Promise.all(dbInvoices.map(async (inv) => {
            if (inv.stripeInvoiceId) {
                try {
                    const stripeInvoice = await stripe.invoices.retrieve(inv.stripeInvoiceId)
                    return {
                        ...inv,
                        hosted_invoice_url: stripeInvoice.hosted_invoice_url,
                        invoice_pdf: stripeInvoice.invoice_pdf
                    }
                } catch (e) {
                    console.error(`[getInvoices] Failed to retrieve Stripe invoice ${inv.stripeInvoiceId}:`, e.message)
                    return inv
                }
            }
            return inv
        }))

        res.json(invoices)
    } catch (err) {
        console.error("[getInvoices] Error:", err)
        res.status(500).json({ message: "Server error fetching invoices" })
    }
}

/**
 * DELETE /owner/billing/invoices/:id
 * Archives (deletes) a billing invoice from the local DB.
 */
export async function archiveInvoice(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const { id } = req.params

        const invoice = await BillingInvoice.findOneAndDelete({ _id: id, businessId })
        if (!invoice) return res.status(404).json({ message: "Invoice not found" })

        res.json({ message: "Invoice archived successfully" })
    } catch (err) {
        console.error("[archiveInvoice] Error:", err)
        res.status(500).json({ message: "Server error archiving invoice" })
    }
}

/**
 * PATCH /owner/billing/platform-fee-settings
 * Updates passPlatformFeeToCustomer and platformFeeLabel.
 */
export async function updatePlatformFeeSettings(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const { passPlatformFeeToCustomer, platformFeeLabel, platformFeeMode, customerPlatformFeePercent } = req.body
        const updateObj = {}

        if (typeof passPlatformFeeToCustomer === "boolean") {
            updateObj.passPlatformFeeToCustomer = passPlatformFeeToCustomer
        }
        if (["business_absorbs", "customer_pays", "split"].includes(platformFeeMode)) {
            updateObj.platformFeeMode = platformFeeMode
        }
        if (typeof customerPlatformFeePercent === "number" && customerPlatformFeePercent >= 0 && customerPlatformFeePercent <= 100) {
            updateObj.customerPlatformFeePercent = customerPlatformFeePercent
        }
        if (typeof platformFeeLabel === "string" && platformFeeLabel.trim().length > 0) {
            updateObj.platformFeeLabel = platformFeeLabel.trim().substring(0, 50)
        }

        if (Object.keys(updateObj).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" })
        }

        const biz = await Business.findOneAndUpdate(
            { businessId },
            { $set: updateObj },
            { new: true }
        ).lean()

        if (!biz) return res.status(404).json({ message: "Business not found" })

        // Look up the plan rate to return to the frontend
        const currentPlan = biz.currentPlan || "basic"
        const platformFeeRate = await getPlanOfflineCommissionRate(currentPlan)

        res.json({
            passPlatformFeeToCustomer: biz.passPlatformFeeToCustomer,
            platformFeeMode: biz.platformFeeMode || "business_absorbs",
            customerPlatformFeePercent: biz.customerPlatformFeePercent || 0,
            platformFeeLabel: biz.platformFeeLabel,
            platformFeeRate
        })
    } catch (err) {
        console.error("[updatePlatformFeeSettings] Error:", err)
        res.status(500).json({ message: "Server error updating platform fee settings" })
    }
}

/**
 * POST /owner/billing/report-usage
 *
 * Finds all paid offline orders that haven't been reported to Stripe yet,
 * calculates the commission, sends a single usage record to Stripe Metered Billing,
 * and atomically marks all reported orders with commissionReportedToStripe = true.
 *
 * Rules:
 *  - If no stripeMeteredSubscriptionItemId exists, returns a 400 billing-not-set-up response.
 *  - If there are no pending orders, returns early with a 200 (already up to date).
 *  - Stripe is called FIRST. Only on success are orders marked as reported.
 *  - Idempotent: re-running after a partial failure will retry unreported orders only.
 */
export async function reportOfflineUsage(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) return res.status(404).json({ message: "Business not found" })

        // Guard: Stripe metered subscription must exist before we can report usage
        if (!biz.stripeMeteredSubscriptionItemId) {
            return res.status(400).json({
                code: "BILLING_NOT_SETUP",
                message: "Offline usage reporting is unavailable. Please select a plan to set up billing first.",
            })
        }

        // Gather all unreported paid offline orders
        const unreportedOrders = await Order.find({
            businessId,
            paymentChannel: "offline",
            paymentStatus: "paid",
            commissionReportedToStripe: false,
        }).lean()

        if (unreportedOrders.length === 0) {
            return res.json({
                success: true,
                reported: 0,
                commissionCentsReported: 0,
                message: "No unreported offline orders. Usage is already up to date.",
            })
        }

        // Resolve commission rate for this business's current plan
        const offlineCommissionRate = await getPlanOfflineCommissionRate(biz.currentPlan || "basic")
        const commissionMultiplier = offlineCommissionRate / 100

        // Calculate total commission in cents (1 unit = 1 cent of commission in Stripe)
        let commissionCents = 0
        for (const o of unreportedOrders) {
            if (o.commissionAmountCents != null) {
                commissionCents += o.commissionAmountCents
            } else if (o.platformFeeTotal > 0) {
                commissionCents += Math.round(o.platformFeeTotal * 100)
            } else {
                const subtotal = o.subtotal || 0
                commissionCents += Math.round(subtotal * 100 * commissionMultiplier)
            }
        }

        if (commissionCents <= 0) {
            return res.json({
                success: true,
                reported: unreportedOrders.length,
                commissionCentsReported: 0,
                message: "No commission due for these orders.",
            })
        }

        // Report to Stripe first. Only mark local orders after Stripe accepts the usage event.
        // We use the new Billing Meters API instead of legacy subscription items.
        // The event_name matches the one created by the seed script.
        const timestamp = Math.floor(Date.now() / 1000)
        await stripe.billing.meterEvents.create({
            event_name: 'offline_commission_cents',
            payload: {
                stripe_customer_id: biz.stripeCustomerId,
                value: String(commissionCents),
            },
            timestamp,
        })

        // Stripe succeeded, so mark all orders as reported.
        const orderIds = unreportedOrders.map(o => o._id)
        await Order.updateMany(
            { _id: { $in: orderIds } },
            { $set: { commissionReportedToStripe: true, stripeUsageReportedAt: new Date() } }
        )

        console.log(
            `[reportOfflineUsage] businessId=${businessId} reported ${unreportedOrders.length} orders, ` +
            `commission=${commissionCents} cents to subscriptionItem=${biz.stripeMeteredSubscriptionItemId}`
        )

        res.json({
            success: true,
            reported: unreportedOrders.length,
            commissionCentsReported: commissionCents,
            message: `Reported ${commissionCents} cents of offline commission to Stripe for ${unreportedOrders.length} orders.`,
        })
    } catch (err) {
        console.error("[reportOfflineUsage] Error:", err)
        // Do NOT mark orders as reported if Stripe call threw
        if (err?.type === "StripeInvalidRequestError") {
            return res.status(400).json({ message: `Stripe error: ${err.message}` })
        }
        res.status(500).json({ message: "Server error reporting offline usage" })
    }
}
