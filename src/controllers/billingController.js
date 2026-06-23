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

        res.json({
            billingStatus: biz.billingStatus || 'incomplete',
            billingEnabled: biz.billingEnabled || false,
            currentPlan: biz.currentPlan === 'enterprise' ? 'pro' : (biz.currentPlan || 'basic'),
            planActivatedAt: biz.planActivatedAt || null,
            billingCycle: biz.billingCycle || 'monthly',
            nextBillingDate: biz.nextBillingDate || null,
            paymentMethodBrand: biz.paymentMethodBrand || null,
            paymentMethodLast4: biz.paymentMethodLast4 || null,
            paymentMethodExpMonth: biz.paymentMethodExpMonth || null,
            paymentMethodExpYear: biz.paymentMethodExpYear || null,
            scheduledDowngradePlan: biz.scheduledDowngradePlan === 'enterprise' ? 'pro' : (biz.scheduledDowngradePlan || null),
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

        // Return the updated billing overview
        res.json({
            billingStatus: biz.billingStatus || 'incomplete',
            billingEnabled: biz.billingEnabled || false,
            currentPlan: biz.currentPlan === 'enterprise' ? 'pro' : (biz.currentPlan || 'basic'),
            planActivatedAt: biz.planActivatedAt || null,
            billingCycle: biz.billingCycle || 'monthly',
            nextBillingDate: biz.nextBillingDate || null,
            paymentMethodBrand: biz.paymentMethodBrand || null,
            paymentMethodLast4: biz.paymentMethodLast4 || null,
            paymentMethodExpMonth: biz.paymentMethodExpMonth || null,
            paymentMethodExpYear: biz.paymentMethodExpYear || null
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

        // Load the target plan definition (must have Stripe Price IDs from seed script)
        const targetPlan = await Plan.findOne({ slug: planSlug }).lean()
        if (!targetPlan) {
            return res.status(404).json({ message: `Plan '${planSlug}' not found in database.` })
        }
        if (!targetPlan.stripeMeteredPriceId) {
            return res.status(500).json({
                code: "PLAN_NOT_SEEDED",
                message: "Plan pricing has not been configured. Please run the seed script."
            })
        }

        // Load the current plan definition to determine direction
        const currentPlan = await Plan.findOne({ slug: biz.currentPlan || 'basic' }).lean()
        const isUpgrade = targetPlan.monthlyPrice >= (currentPlan?.monthlyPrice ?? 0)

        let stripeSubscriptionId = biz.stripeSubscriptionId
        let stripeMeteredSubscriptionItemId = biz.stripeMeteredSubscriptionItemId
        let scheduledDowngradePlan = null
        let effectivePlan = planSlug
        let downgradeScheduled = false

        // ─── Case 1: No existing subscription — create fresh ─────────────────────
        if (!stripeSubscriptionId) {
            const items = [
                { price: targetPlan.stripeMeteredPriceId },
            ]
            // Only add a base price item for paid plans
            if (targetPlan.stripeBasePriceId) {
                items.unshift({ price: targetPlan.stripeBasePriceId })
            }

            const subscription = await stripe.subscriptions.create({
                customer: biz.stripeCustomerId,
                items,
                metadata: {
                    businessId,
                    quickserve_plan: planSlug,
                },
            })

            stripeSubscriptionId = subscription.id
            // The metered item is the one with usage_type = metered
            const meteredItem = subscription.items.data.find(
                i => i.price.id === targetPlan.stripeMeteredPriceId
            )
            stripeMeteredSubscriptionItemId = meteredItem?.id ?? null

        // ─── Case 2: Existing subscription — Update plan (Upgrade or Downgrade) ────
        } else {
            const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)

            if (isUpgrade) {
                // Identify existing items
                const baseItem = subscription.items.data.find(i => i.price.recurring?.usage_type !== 'metered');
                const meteredItem = subscription.items.data.find(i => i.price.recurring?.usage_type === 'metered');

                const itemsToUpdate = [];

                // Update or add base item
                if (targetPlan.stripeBasePriceId) {
                    if (baseItem) {
                        itemsToUpdate.push({ id: baseItem.id, price: targetPlan.stripeBasePriceId });
                    } else {
                        itemsToUpdate.push({ price: targetPlan.stripeBasePriceId });
                    }
                } else if (baseItem) {
                    itemsToUpdate.push({ id: baseItem.id, deleted: true });
                }

                // Update or add metered item
                if (meteredItem) {
                    itemsToUpdate.push({ id: meteredItem.id, price: targetPlan.stripeMeteredPriceId });
                } else {
                    itemsToUpdate.push({ price: targetPlan.stripeMeteredPriceId });
                }

                const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
                    items: itemsToUpdate,
                    proration_behavior: 'create_prorations',
                    metadata: { quickserve_plan: planSlug },
                })

                const updatedMeteredItem = updated.items.data.find(
                    i => i.price.id === targetPlan.stripeMeteredPriceId
                )
                stripeMeteredSubscriptionItemId = updatedMeteredItem?.id ?? null
            } else {
                // Downgrade: Schedule it for the next billing cycle
                downgradeScheduled = true
                effectivePlan = biz.currentPlan // Current plan stays active
                scheduledDowngradePlan = planSlug
            }
        }

        let scheduledPlanEffectiveDate = null
        if (downgradeScheduled && stripeSubscriptionId) {
            const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
            scheduledPlanEffectiveDate = new Date(sub.current_period_end * 1000)
        }

        // ─── Stripe succeeded — now update the database ──────────────────────────
        await Business.findOneAndUpdate(
            { businessId },
            {
                $set: {
                    currentPlan: effectivePlan,
                    plan: effectivePlan, // Update legacy plan field
                    planActivatedAt: downgradeScheduled ? biz.planActivatedAt : new Date(),
                    stripeSubscriptionId,
                    stripeMeteredSubscriptionItemId,
                    scheduledDowngradePlan,
                    scheduledPlanEffectiveDate,
                    billingStatus: 'active',
                    billingEnabled: true,
                }
            },
            { new: true }
        )

        const responseMessage = downgradeScheduled
            ? `Downgrade to ${planSlug} scheduled for end of billing period.`
            : `Successfully switched to ${planSlug} plan.`

        res.json({
            success: true,
            currentPlan: effectivePlan,
            scheduledDowngradePlan: scheduledDowngradePlan ?? null,
            stripeMeteredSubscriptionItemId,
            message: responseMessage,
        })
    } catch (err) {
        console.error("[updatePlan] Error:", err)
        const stripeCode = err?.raw?.code || err?.code
        if (stripeCode === "resource_missing") {
            return res.status(400).json({ message: "Stripe subscription or price not found. Please run the plan seed script." })
        }
        if (stripeCode === "customer_deleted") {
            return res.status(400).json({ message: "Stripe customer record not found. Please re-add your payment method." })
        }
        res.status(500).json({ message: err.message || "Server error updating plan. Please try again." })
    }
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
        const offlineCommissionRate = await getPlanOfflineCommissionRate(currentPlan)
        const commissionMultiplier = offlineCommissionRate / 100

        // Only aggregate orders NOT yet reported to Stripe — prevents unbounded accumulation
        const pendingOrders = await Order.find({
            businessId,
            paymentChannel: 'offline',
            paymentStatus: 'paid',
            commissionReportedToStripe: false,
        }).lean()

        let pendingCommissionCents = 0
        for (const o of pendingOrders) {
            if (o.commissionAmountCents != null) {
                pendingCommissionCents += o.commissionAmountCents
            } else if (o.platformFeeTotal > 0) {
                pendingCommissionCents += Math.round(o.platformFeeTotal * 100)
            } else {
                pendingCommissionCents += Math.round((o.subtotal || 0) * 100 * commissionMultiplier)
            }
        }

        // Historical totals (all time) for display purposes only
        const allOrders = await Order.find({
            businessId,
            paymentChannel: 'offline',
            paymentStatus: 'paid',
        }).lean()

        let totalGrossCents = 0
        let totalCustomerPaidFeesCents = 0
        let totalBusinessOwedCommissionCents = 0

        for (const o of allOrders) {
            const subtotal = o.subtotal || 0
            const taxAmount = o.taxAmount || 0
            totalGrossCents += Math.round((subtotal + taxAmount) * 100)

            if (o.platformFeeCents != null) {
                // New split logic
                totalCustomerPaidFeesCents += (o.customerPlatformFeeCents || 0)
                totalBusinessOwedCommissionCents += (o.businessAbsorbedPlatformFeeCents || 0)
            } else if (o.commissionAmountCents != null) {
                if (o.platformFeeTotal > 0) {
                    totalCustomerPaidFeesCents += o.commissionAmountCents
                } else {
                    totalBusinessOwedCommissionCents += o.commissionAmountCents
                }
            } else if (o.platformFeeTotal > 0) {
                totalCustomerPaidFeesCents += Math.round(o.platformFeeTotal * 100)
            } else {
                totalBusinessOwedCommissionCents += Math.round(subtotal * 100 * commissionMultiplier)
            }
        }

        const totalCommissionCents = totalCustomerPaidFeesCents + totalBusinessOwedCommissionCents

        res.json({
            currentPlan,
            offlineCommissionRate,
            totalGross: totalGrossCents / 100,
            customerPaidFees: totalCustomerPaidFeesCents / 100,
            businessOwedCommission: totalBusinessOwedCommissionCents / 100,
            totalCommission: totalCommissionCents / 100,
            pendingCommission: pendingCommissionCents / 100, // what's owed but not yet reported
            pendingOrderCount: pendingOrders.length,
            billingReady: !!biz.stripeMeteredSubscriptionItemId,
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
 *  - If no stripeMeteredSubscriptionItemId exists, returns a 400 — billing not set up.
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

        // ─── Report to Stripe FIRST ────────────────────────────────────────────────
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

        // ─── Stripe succeeded — mark all orders as reported ────────────────────────
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
