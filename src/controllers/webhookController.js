import Stripe from "stripe";
import PendingCheckout from "../models/PendingCheckout.js";
import Business from "../models/Business.js";
import Order from "../models/order.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import { generateOrderId } from "../utils/orderId.js";
import { toOrderDTO } from "../utils/orderDTO.js";
import { publishEvent } from "../utils/sseManager.js";
import { sendReceiptEmail } from "../utils/emailService.js";
import { upsertGuestProfileFromOrder } from "../services/guestProfileService.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * POST /webhook/stripe
 */
export async function handleStripeWebhook(req, res) {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        console.log("[stripeWebhook] Signature verified:", event.type);
    } catch (err) {
        console.error("[stripeWebhook] Signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === "account.updated") {
            const account = event.data.object;
            const chargesEnabled = account.charges_enabled === true;
            const payoutsEnabled = account.payouts_enabled === true;

            await Business.findOneAndUpdate(
                { stripeAccountId: account.id },
                {
                    stripeChargesEnabled: chargesEnabled,
                    stripePayoutsEnabled: payoutsEnabled,
                    stripeOnboardingComplete: chargesEnabled && payoutsEnabled,
                }
            );

            return res.status(200).send();
        }

        if (event.type === "invoice.paid") {
            const invoice = event.data.object;
            if (invoice.subscription) {
                const biz = await Business.findOne({ stripeSubscriptionId: invoice.subscription });
                if (biz && biz.scheduledDowngradePlan) {
                    console.log(`[webhook] Applying scheduled downgrade for business ${biz.businessId} to ${biz.scheduledDowngradePlan}`);
                    const targetPlan = await Plan.findOne({ slug: biz.scheduledDowngradePlan }).lean();
                    
                    if (targetPlan && targetPlan.stripeMeteredPriceId) {
                        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
                        const baseItem = subscription.items.data.find(i => i.price.recurring?.usage_type !== 'metered');
                        const meteredItem = subscription.items.data.find(i => i.price.recurring?.usage_type === 'metered');
                        
                        const itemsToUpdate = [];
                        
                        // Downgrade base item
                        if (targetPlan.stripeBasePriceId) {
                            if (baseItem) {
                                itemsToUpdate.push({ id: baseItem.id, price: targetPlan.stripeBasePriceId });
                            } else {
                                itemsToUpdate.push({ price: targetPlan.stripeBasePriceId });
                            }
                        } else if (baseItem) {
                            itemsToUpdate.push({ id: baseItem.id, deleted: true });
                        }
                        
                        // Downgrade metered item
                        if (meteredItem) {
                            itemsToUpdate.push({ id: meteredItem.id, price: targetPlan.stripeMeteredPriceId });
                        } else {
                            itemsToUpdate.push({ price: targetPlan.stripeMeteredPriceId });
                        }
                        
                        const updated = await stripe.subscriptions.update(invoice.subscription, {
                            items: itemsToUpdate,
                            proration_behavior: 'none', // Next cycle has started, no prorations needed
                            metadata: { quickserve_plan: biz.scheduledDowngradePlan },
                        });
                        
                        const updatedMeteredItem = updated.items.data.find(
                            i => i.price.id === targetPlan.stripeMeteredPriceId
                        );
                        
                        await Business.findOneAndUpdate(
                            { _id: biz._id },
                            {
                                $set: {
                                    currentPlan: biz.scheduledDowngradePlan,
                                    plan: biz.scheduledDowngradePlan,
                                    stripeMeteredSubscriptionItemId: updatedMeteredItem?.id ?? null,
                                    scheduledDowngradePlan: null,
                                    scheduledPlanEffectiveDate: null
                                }
                            }
                        );
                        console.log(`[webhook] Downgrade complete for business ${biz.businessId}`);
                    }
                }
            }
            return res.status(200).send();
        }

        if (event.type !== "checkout.session.completed") {
            return res.status(200).send();
        }

        const session = event.data.object;
        const { pendingCheckoutId } = session.metadata || {};

        if (!pendingCheckoutId) {
            console.error("[webhook] checkout.session.completed missing pendingCheckoutId in metadata");
            return res.status(200).send();
        }

        const pending = await PendingCheckout.findById(pendingCheckoutId);

        if (!pending) {
            console.error(`[webhook] PendingCheckout not found: ${pendingCheckoutId}`);
            return res.status(200).send();
        }

        if (!pending.businessId) {
            console.error(`[webhook] PendingCheckout missing businessId: ${pendingCheckoutId}`);
            return res.status(200).send();
        }

        const businessId = pending.businessId;
        const orderId = pending.orderId || generateOrderId(pending.tableNumber);

        // Idempotency guard — do not create duplicate orders on Stripe retry
        let order = await Order.findOne({ businessId, orderId });

        if (order) {
            let updated = false;
            
            // If the order existed but wasn't paid yet (offline-to-online flow)
            if (order.paymentStatus !== "paid") {
                order.paymentStatus = "paid";
                order.paymentChannel = "online";
                order.paidVia = "online_card";
                order.stripeSessionId = pending.stripeSessionId || session.id;
                
                // Stripe Connect split metadata
                order.stripePaymentIntentId = pending.stripePaymentIntentId || session.payment_intent || null;
                order.stripeConnectedAccountId = pending.stripeConnectedAccountId || null;
                if (pending.grossAmount !== undefined) order.grossAmount = pending.grossAmount;
                if (pending.netToBusinessAmount !== undefined) order.netToBusinessAmount = pending.netToBusinessAmount;
                if (pending.planApplied !== undefined) order.planApplied = pending.planApplied;
                if (pending.commissionRateApplied !== undefined) order.commissionRateApplied = pending.commissionRateApplied;
                if (pending.commissionAmountCents !== undefined) order.commissionAmountCents = pending.commissionAmountCents;
                
                updated = true;
            }

            // Re-attempt receipt email if not yet sent
            const customerEmail = pending.receiptEmail || session.customer_details?.email || order.receiptEmail || null;
            if (customerEmail && !order.receiptSent) {
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    if (emailSent) {
                        order.receiptSent = true;
                        updated = true;
                    }
                } catch (err) {
                    console.error("[webhook] Receipt retry error:", err.message);
                }
            }
            
            if (updated) {
                await order.save();
                // Notify waiter/table that the order was paid online
                const orderDTO = toOrderDTO(order);
                await publishEvent("order_updated", businessId, ["waiter", "table"], { order: orderDTO });
            }

            if (customerEmail) {
                upsertGuestProfileFromOrder({
                    businessId,
                    order,
                    email: customerEmail
                });
            }
        } else {
            const hasFood = pending.items.some((i) => i.category === "food" || i.type === "food");
            const initialStatus = hasFood ? "placed" : "ready";
            // For a brand new order, there's no existing order.receiptEmail to fall back on yet
            const customerEmail = pending.receiptEmail || session.customer_details?.email || null;

            // Prefer the label already cached on PendingCheckout (stored at checkout creation).
            // Fall back to a live ServicePoint lookup for older pending docs missing it.
            let tableLabel = pending.tableLabel || "";
            if (!tableLabel) {
                const sp = await ServicePoint.findOne({ servicePointId: pending.tableNumber, businessId }).lean();
                tableLabel = sp?.label || sp?.code || pending.tableNumber;
            }

            order = await Order.create({
                businessId,
                orderId,
                tableNumber: pending.tableNumber,
                tableLabel,
                orderType: pending.orderType,
                sessionId: pending.sessionId,
                items: pending.items,
                status: initialStatus,
                total: pending.total,
                currency: pending.currency,
                paymentChannel: "online",
                paymentStatus: "paid",
                paidVia: "online_card",
                stripeSessionId: pending.stripeSessionId || session.id,

                // Stripe Connect split metadata
                stripePaymentIntentId:    pending.stripePaymentIntentId || session.payment_intent || null,
                stripeConnectedAccountId: pending.stripeConnectedAccountId || null,
                grossAmount:              pending.grossAmount          ?? null,
                netToBusinessAmount:      pending.netToBusinessAmount  ?? null,

                // Frozen commission fields
                planApplied:              pending.planApplied           ?? null,
                commissionRateApplied:    pending.commissionRateApplied ?? null,
                commissionAmountCents:    pending.commissionAmountCents ?? 0,

                receiptEmail: customerEmail,
                receiptSent: false,
            });

            console.log(`[webhook] Order created: orderId=${orderId}, businessId=${businessId}`);

            if (customerEmail) {
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    if (emailSent) {
                        await Order.findOneAndUpdate({ businessId, orderId }, { receiptSent: true });
                    } else {
                        console.error(`[webhook] Receipt email failed for orderId=${orderId}`);
                    }
                } catch (err) {
                    console.error("[webhook] Receipt email error:", err.message);
                }
            }

            if (customerEmail) {
                upsertGuestProfileFromOrder({
                    businessId,
                    order,
                    email: customerEmail
                });
            }

            const orderDTO = toOrderDTO(order);
            const foodItems = order.items.filter((i) => i.category === "food" || i.type === "food");

            if (foodItems.length > 0) {
                const kitchenDTO = { ...orderDTO, items: foodItems };
                await publishEvent("order_created", businessId, ["kitchen"], { order: kitchenDTO });
            }

            await publishEvent("order_created", businessId, ["waiter", "table", "anon"], { order: orderDTO });
        }

        await PendingCheckout.findByIdAndDelete(pendingCheckoutId);

        return res.status(200).send();
    } catch (error) {
        console.error("[stripeWebhook] Error processing webhook:", error);
        return res.status(500).send("Internal Server Error");
    }
}