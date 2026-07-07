import Stripe from "stripe";
import PendingCheckout from "../models/PendingCheckout.js";
import Business from "../models/Business.js";
import Order from "../models/order.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import MenuItem from "../models/menuItem.js";
import { generateOrderId } from "../utils/orderId.js";
import { toOrderDTO } from "../utils/orderDTO.js";
import { publishEvent } from "../utils/sseManager.js";
import { sendReceiptEmail, sendEmail } from "../utils/emailService.js";
import { upsertGuestProfileFromOrder } from "../services/guestProfileService.js";
import { deductTrackedStock } from "../services/inventoryService.js";
import { buildOrderEstimate } from "../utils/orderEstimate.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
function getSubscriptionPeriodFromStripe(subscription) {
    if (!subscription?.current_period_start || !subscription?.current_period_end) return null;

    const start = new Date(subscription.current_period_start * 1000);
    const invoiceAt = new Date(subscription.current_period_end * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(invoiceAt.getTime())) return null;

    return {
        start,
        end: new Date(invoiceAt.getTime() - 1),
        invoiceAt,
    };
}

function getSubscriptionPeriodUpdate(subscription) {
    const period = getSubscriptionPeriodFromStripe(subscription);
    if (!period) return {};

    return {
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        nextInvoiceDate: period.invoiceAt,
        nextBillingDate: period.invoiceAt,
    };
}

async function handleBusinessRestorationIfNeeded(biz, updateFields) {
    if (biz?.offlineServiceRestricted) {
        updateFields.offlineServiceRestricted = false;
        updateFields.offlineServiceRestrictedAt = null;
        updateFields.offlineRestrictionEmailSentAt = null;
        updateFields.overdueReminderSentAt = null;
        updateFields.finalWarningSentAt = null;
        updateFields.billingFailedAt = null;
        updateFields.billingRestoredAt = new Date();

        const recipient = biz.ownerEmail || biz.contactEmail || null;
        if (recipient) {
            const displayName = biz.displayName || biz.name || "there";
            const emailBody = `
                <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                    <p>Hi ${displayName},</p>
                    <p>Good news! Your QuickServe billing has been resolved and <strong>your offline ordering services have been fully restored</strong>.</p>
                    <p>Thank you for your prompt attention.</p>
                </div>
            `;
            const from = process.env.EMAIL_FROM_BILLING || "QuickServe Billing <billing@quickservehq.com>";
            try {
                const emailSent = await sendEmail({
                    to: recipient,
                    subject: "QuickServe Services Restored",
                    html: emailBody,
                    from,
                });
                if (emailSent) {
                    updateFields.billingRestoredEmailSentAt = new Date();
                }
            } catch (err) {
                console.error(`[webhook] Failed to send restoration email to ${recipient}:`, err.message);
            }
        }
    }
}

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
                if (biz) {
                    let subscription = null;
                    try {
                        subscription = await stripe.subscriptions.retrieve(invoice.subscription);
                    } catch (err) {
                        console.error(`[webhook] Failed to retrieve subscription ${invoice.subscription}:`, err.message);
                    }

                    if (biz.scheduledDowngradePlan) {
                        console.log(`[webhook] Applying scheduled downgrade for business ${biz.businessId} to ${biz.scheduledDowngradePlan}`);
                        const targetPlan = await Plan.findOne({ slug: biz.scheduledDowngradePlan }).lean();

                        if (subscription && targetPlan && targetPlan.stripeMeteredPriceId) {
                            const baseItem = subscription.items.data.find(i => i.price.recurring?.usage_type !== 'metered');
                            const meteredItem = subscription.items.data.find(i => i.price.recurring?.usage_type === 'metered');
                            const itemsToUpdate = [];

                            if (targetPlan.stripeBasePriceId) {
                                if (baseItem) {
                                    itemsToUpdate.push({ id: baseItem.id, price: targetPlan.stripeBasePriceId });
                                } else {
                                    itemsToUpdate.push({ price: targetPlan.stripeBasePriceId });
                                }
                            } else if (baseItem) {
                                itemsToUpdate.push({ id: baseItem.id, deleted: true });
                            }

                            if (meteredItem) {
                                itemsToUpdate.push({ id: meteredItem.id, price: targetPlan.stripeMeteredPriceId });
                            } else {
                                itemsToUpdate.push({ price: targetPlan.stripeMeteredPriceId });
                            }

                            const updated = await stripe.subscriptions.update(invoice.subscription, {
                                items: itemsToUpdate,
                                proration_behavior: 'none',
                                metadata: {
                                    businessId: biz.businessId,
                                    planSlug: biz.scheduledDowngradePlan,
                                    quickserve_plan: biz.scheduledDowngradePlan,
                                },
                            });

                            const periodUpdate = getSubscriptionPeriodUpdate(updated);
                            const updatedMeteredItem = updated.items.data.find(
                                i => i.price.id === targetPlan.stripeMeteredPriceId
                            );

                            const updateFields = {
                                currentPlan: biz.scheduledDowngradePlan,
                                plan: biz.scheduledDowngradePlan,
                                planActivatedAt: periodUpdate.currentPeriodStart || new Date(),
                                stripeMeteredSubscriptionItemId: updatedMeteredItem?.id ?? null,
                                stripeSubscriptionStatus: updated.status,
                                scheduledDowngradePlan: null,
                                scheduledPlanEffectiveDate: null,
                                billingStatus: 'active',
                                billingFailedAt: null,
                                ...periodUpdate,
                            };
                            await handleBusinessRestorationIfNeeded(biz, updateFields);

                            await Business.findOneAndUpdate(
                                { _id: biz._id },
                                { $set: updateFields }
                            );
                            console.log(`[webhook] Downgrade complete for business ${biz.businessId}`);
                        }
                    } else if (subscription) {
                        const periodUpdate = getSubscriptionPeriodUpdate(subscription);
                        if (Object.keys(periodUpdate).length > 0) {
                            const updateFields = {
                                stripeSubscriptionStatus: subscription.status,
                                billingStatus: 'active',
                                billingFailedAt: null,
                                ...periodUpdate,
                            };
                            await handleBusinessRestorationIfNeeded(biz, updateFields);

                            await Business.findOneAndUpdate(
                                { _id: biz._id },
                                { $set: updateFields }
                            );
                        }
                    }

                    if (!biz.offlineServiceRestricted) {
                        const recipient = biz.ownerEmail || biz.contactEmail || null;
                        if (recipient) {
                            const displayName = biz.displayName || biz.name || "there";
                            const hasAmount = typeof invoice.total === "number";
                            const amount = hasAmount ? (invoice.total / 100).toFixed(2) : null;
                            const amountText = amount ? ` of €${amount}` : "";
                            const emailBody = `
                                <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                                    <p>Hi ${displayName},</p>
                                    <p>Your recent QuickServe payment${amountText} has been successfully processed.</p>
                                    <p>Thank you for your continued partnership!</p>
                                </div>
                            `;
                            const from = process.env.EMAIL_FROM_BILLING || "QuickServe Billing <billing@quickservehq.com>";
                            try {
                                await sendEmail({
                                    to: recipient,
                                    subject: "QuickServe Payment Successful",
                                    html: emailBody,
                                    from,
                                });
                            } catch (err) {
                                console.error(`[webhook] Failed to send payment receipt email to ${recipient}:`, err.message);
                            }
                        }
                    }
                }
            }
            return res.status(200).send();
        }

        if (event.type === "invoice.payment_failed") {
            const invoice = event.data.object;
            if (invoice.subscription) {
                await Business.findOneAndUpdate(
                    { stripeSubscriptionId: invoice.subscription },
                    {
                        $set: {
                            billingStatus: 'past_due',
                        },
                        $setOnInsert: {
                            billingFailedAt: new Date()
                        }
                    }
                );
            }
            return res.status(200).send();
        }

        if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
            const subscription = event.data.object;
            
            const updateFields = { stripeSubscriptionStatus: subscription.status };
            
            if (subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "canceled") {
                updateFields.billingStatus = subscription.status === "canceled" ? 'cancelled' : 'past_due';
                // Only set failed at if it wasn't already set by a prior failure
            } else if (subscription.status === "active") {
                updateFields.billingStatus = 'active';
                updateFields.billingFailedAt = null;
            }

            const biz = await Business.findOne({ stripeSubscriptionId: subscription.id });
            if (biz) {
                if ((subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "canceled") && !biz.billingFailedAt) {
                    updateFields.billingFailedAt = new Date();
                } else if (subscription.status === "active") {
                    await handleBusinessRestorationIfNeeded(biz, updateFields);
                }
                
                await Business.updateOne(
                    { _id: biz._id },
                    { $set: updateFields }
                );
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
                order.paidAt = order.paidAt || new Date();
                order.stripeSessionId = pending.stripeSessionId || session.id;
                
                // Stripe Connect split metadata
                order.stripePaymentIntentId = pending.stripePaymentIntentId || session.payment_intent || null;
                order.stripeConnectedAccountId = pending.stripeConnectedAccountId || null;
                if (pending.grossAmount !== undefined) order.grossAmount = pending.grossAmount;
                if (pending.netToBusinessAmount !== undefined) order.netToBusinessAmount = pending.netToBusinessAmount;
                if (pending.planApplied !== undefined) order.planApplied = pending.planApplied;
                if (pending.commissionRateApplied !== undefined) order.commissionRateApplied = pending.commissionRateApplied;
                if (pending.commissionAmountCents !== undefined) order.commissionAmountCents = pending.commissionAmountCents;
                order.planAtOrder = pending.planAtOrder ?? pending.planApplied ?? order.planAtOrder ?? order.planApplied ?? null;
                order.commissionRateAtOrder = pending.commissionRateAtOrder ?? pending.commissionRateApplied ?? order.commissionRateAtOrder ?? order.commissionRateApplied ?? null;
                order.platformFeeRateAtOrder = pending.platformFeeRateAtOrder ?? pending.commissionRateApplied ?? order.platformFeeRateAtOrder ?? order.commissionRateApplied ?? null;

                if (pending.platformFeeCents !== undefined) order.platformFeeCents = pending.platformFeeCents;
                if (pending.customerPlatformFeeCents !== undefined) order.customerPlatformFeeCents = pending.customerPlatformFeeCents;
                if (pending.businessAbsorbedPlatformFeeCents !== undefined) order.businessAbsorbedPlatformFeeCents = pending.businessAbsorbedPlatformFeeCents;
                if (pending.platformFeeMode !== undefined) order.platformFeeMode = pending.platformFeeMode;
                if (pending.customerPlatformFeePercent !== undefined) order.customerPlatformFeePercent = pending.customerPlatformFeePercent;
                if (pending.customerPlatformFeeCents !== undefined) order.platformFeeTotal = Number((pending.customerPlatformFeeCents / 100).toFixed(2));
                order.tipAmount = pending.tipAmount ?? order.tipAmount ?? 0;
                order.tipType = pending.tipType ?? order.tipType ?? null;
                order.tipPercentage = pending.tipPercentage ?? order.tipPercentage ?? null;

                // Sync financial fields from PendingCheckout so the receipt email
                // has the full breakdown (subtotal, tax, tip, service fee).
                if (pending.subtotal !== undefined && pending.subtotal > 0) order.subtotal = pending.subtotal;
                if (pending.taxAmount !== undefined) order.taxAmount = pending.taxAmount;
                if (pending.total !== undefined && pending.total > 0) order.total = pending.total;
                
                updated = true;
            }

            const readyMs = order.estimatedReadyAt ? new Date(order.estimatedReadyAt).getTime() : NaN;
            const createdMs = order.createdAt ? new Date(order.createdAt).getTime() : NaN;
            const estimateExpiredOrInvalid =
                !Number.isFinite(readyMs) ||
                readyMs <= Date.now() ||
                (Number.isFinite(createdMs) && readyMs <= createdMs);

            if (estimateExpiredOrInvalid) {
                const estimate = buildOrderEstimate(order.items?.length ? order.items : pending.items, new Date());
                order.estimatedPrepMinutes = estimate.estimatedPrepMinutes;
                order.estimatedReadyAt = estimate.estimatedReadyAt;
                updated = true;
            }

            // Re-attempt receipt email if not yet sent
            const customerEmail = pending.receiptEmail || session.customer_details?.email || order.receiptEmail || null;
            if (customerEmail && !order.receiptSent) {
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    if (emailSent) {
                        order.receiptSent = true;
                        order.receiptSentAt = new Date();
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
            // Match offline order creation: the ETA starts when the real Order is created.
            const orderCreatedAt = new Date();
            const estimate = buildOrderEstimate(pending.items, orderCreatedAt);
            // For a brand new order, there's no existing order.receiptEmail to fall back on yet
            const customerEmail = pending.receiptEmail || session.customer_details?.email || null;

            // Prefer the label already cached on PendingCheckout (stored at checkout creation).
            // Fall back to a live ServicePoint lookup for older pending docs missing it.
            let tableLabel = pending.tableLabel || "";
            if (!tableLabel) {
                const sp = await ServicePoint.findOne({ servicePointId: pending.tableNumber, businessId }).lean();
                tableLabel = sp?.label || sp?.code || pending.tableNumber;
            }

            console.log(`[webhook] Creating new Order for orderId=${orderId}, subtotal=${pending.subtotal}, taxAmount=${pending.taxAmount}, tipAmount=${pending.tipAmount}, total=${pending.total}`);
            order = await Order.create({
                businessId,
                orderId,
                tableNumber: pending.tableNumber,
                tableLabel,
                orderType: pending.orderType,
                sessionId: pending.sessionId,
                items: pending.items,
                status: initialStatus,
                createdAt: orderCreatedAt,
                estimatedPrepMinutes: estimate.estimatedPrepMinutes,
                estimatedReadyAt: estimate.estimatedReadyAt,
                total: pending.total,
                currency: pending.currency,
                paymentChannel: "online",
                paymentStatus: "paid",
                paidVia: "online_card",
                paidAt: orderCreatedAt,
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
                planAtOrder:              pending.planAtOrder           ?? pending.planApplied           ?? null,
                commissionRateAtOrder:    pending.commissionRateAtOrder ?? pending.commissionRateApplied ?? null,
                platformFeeRateAtOrder:   pending.platformFeeRateAtOrder ?? pending.commissionRateApplied ?? null,

                // Platform fee split fields
                platformFeeCents:                 pending.platformFeeCents                 ?? 0,
                customerPlatformFeeCents:         pending.customerPlatformFeeCents         ?? 0,
                businessAbsorbedPlatformFeeCents: pending.businessAbsorbedPlatformFeeCents ?? 0,
                platformFeeMode:                  pending.platformFeeMode                  ?? "business_absorbs",
                customerPlatformFeePercent:       pending.customerPlatformFeePercent       ?? 0,
                platformFeeTotal:                 pending.customerPlatformFeeCents ? Number((pending.customerPlatformFeeCents / 100).toFixed(2)) : 0,
                tipAmount: pending.tipAmount ?? 0,
                tipType: pending.tipType ?? null,
                tipPercentage: pending.tipPercentage ?? null,

                subtotal: pending.subtotal > 0 ? pending.subtotal : pending.items.reduce((s, i) => s + (i.lineTotal || 0), 0),
                taxAmount: pending.taxAmount || 0,

                receiptEmail: customerEmail,
                receiptSent: false,
            });

            console.log(`[webhook] Order created: orderId=${orderId}, businessId=${businessId}`);

            if (customerEmail) {
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    if (emailSent) {
                        await Order.findOneAndUpdate({ businessId, orderId }, { receiptSent: true, receiptSentAt: new Date() });
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

        // Deduct stock for tracked items using shared helper
        if (!order.inventoryDeducted) {
            try {
                const anyDeducted = await deductTrackedStock(order);
                if (anyDeducted) {
                    order.inventoryDeducted = true;
                    order.inventoryDeductedAt = new Date();
                    await order.save();
                }
            } catch (err) {
                console.error(`[Inventory][Online] Failed to deduct stock for order ${orderId}:`, err);
            }
        }

        await PendingCheckout.findByIdAndDelete(pendingCheckoutId);

        return res.status(200).send();
    } catch (error) {
        console.error("[stripeWebhook] Error processing webhook:", error.message, error.stack);
        return res.status(500).send("Internal Server Error");
    }
}
