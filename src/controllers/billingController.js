import Stripe from "stripe"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import Order from "../models/order.js"
import BillingInvoice from "../models/BillingInvoice.js"

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
            currentPlan: biz.currentPlan || 'basic',
            planActivatedAt: biz.planActivatedAt || null,
            billingCycle: biz.billingCycle || 'monthly',
            nextBillingDate: biz.nextBillingDate || null,
            paymentMethodBrand: biz.paymentMethodBrand || null,
            paymentMethodLast4: biz.paymentMethodLast4 || null,
            paymentMethodExpMonth: biz.paymentMethodExpMonth || null,
            paymentMethodExpYear: biz.paymentMethodExpYear || null
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
            currentPlan: biz.currentPlan || 'basic',
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
 * Updates the current subscription plan.
 */
export async function updatePlan(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const { planSlug } = req.body
        if (!['basic', 'growth', 'enterprise'].includes(planSlug)) {
            return res.status(400).json({ message: "Invalid plan selection" })
        }

        const biz = await Business.findOneAndUpdate(
            { businessId },
            { 
                currentPlan: planSlug,
                planActivatedAt: new Date()
            },
            { new: true }
        )

        res.json({ success: true, currentPlan: biz.currentPlan })
    } catch (err) {
        console.error("[updatePlan] Error:", err)
        res.status(500).json({ message: "Server error updating plan" })
    }
}

/**
 * GET /owner/billing/commission
 * Aggregates offline ledgers directly. All totals are calculated securely backend-side.
 */
export async function getCommissionSummary(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        if (!businessId) return res.status(401).json({ message: "Unauthorized" })

        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) return res.status(404).json({ message: "Business not found" })

        const currentPlan = biz.currentPlan || 'basic'
        const planDef = await Plan.findOne({ slug: currentPlan }).lean()
        const offlineCommissionRate = planDef ? planDef.offlineCommissionRate : 2.5 // fallback

        // Aggregate from Order model for offline commission
        const orders = await Order.find({ 
            businessId,
            paymentChannel: 'offline',
            paymentStatus: 'paid'
        }).lean()
        
        let totalGrossCents = 0

        for (const o of orders) {
            // Use subtotal (business revenue) for commission, excluding tax and platform fee
            // Fall back to total for orders created before the subtotal field existed
            const orderRevenue = o.subtotal || o.total || 0
            totalGrossCents += orderRevenue * 100
        }

        // The commission is calculated dynamically based on the current plan rate
        const commissionMultiplier = offlineCommissionRate / 100
        const totalCommissionCents = totalGrossCents * commissionMultiplier
        
        // In the MVP, all offline commission is "pending" until we generate an invoice
        const pendingCommissionCents = totalCommissionCents

        res.json({
            currentPlan,
            offlineCommissionRate,
            totalGross: totalGrossCents / 100,
            totalCommission: totalCommissionCents / 100,
            pendingCommission: pendingCommissionCents / 100
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

        const invoices = await BillingInvoice.find({ businessId }).sort({ createdAt: -1 }).lean()
        res.json(invoices)
    } catch (err) {
        console.error("[getInvoices] Error:", err)
        res.status(500).json({ message: "Server error fetching invoices" })
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

        const { passPlatformFeeToCustomer, platformFeeLabel } = req.body
        const updateObj = {}

        if (typeof passPlatformFeeToCustomer === "boolean") {
            updateObj.passPlatformFeeToCustomer = passPlatformFeeToCustomer
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
        const planDef = await Plan.findOne({ slug: currentPlan }).lean()
        const platformFeeRate = planDef ? planDef.offlineCommissionRate : 2.5

        res.json({
            passPlatformFeeToCustomer: biz.passPlatformFeeToCustomer,
            platformFeeLabel: biz.platformFeeLabel,
            platformFeeRate
        })
    } catch (err) {
        console.error("[updatePlatformFeeSettings] Error:", err)
        res.status(500).json({ message: "Server error updating platform fee settings" })
    }
}
