import Stripe from "stripe";
import PendingCheckout from "../models/PendingCheckout.js";
import Business from "../models/Business.js";
import Order from "../models/order.js";
import Reservation from "../models/Reservation.js";
import ServicePoint from "../models/ServicePoint.js";
import Plan from "../models/Plan.js";
import MenuItem from "../models/menuItem.js";
import { generateOrderId } from "../utils/orderId.js";
import { toOrderDTO } from "../utils/orderDTO.js";
import { publishEvent } from "../utils/sseManager.js";
import {
    getOrderReceiptIdempotencyKey,
    sendReceiptEmail,
    sendEmail,
} from "../utils/emailService.js";
import {
    dispatchCrmOrder,
    recordCrmOrderIntent,
} from "../services/guestProfileService.js";
import { deductTrackedStock } from "../services/inventoryService.js";
import { buildOrderEstimate } from "../utils/orderEstimate.js";
import { generateHotelCheckInCredentials } from "../services/hotelCheckInService.js";
import { confirmReservationPaymentAtomic } from "../services/reservationPaymentConfirmationService.js";
import {
    reconcileStripeReservationRefund,
    ReservationCancellationError,
} from "../services/reservationCancellationService.js";
import { dispatchAutomaticOrderReceipt } from "../services/email/emailDispatchService.js";
import {
    getBillingActionPeriodKey,
    processBillingLifecycleAction,
} from "../services/billingLifecycleService.js";
import { BILLING_JOB_NAMES } from "../queues/index.js";
import {
    claimStripeWebhookEvent,
    completeStripeWebhookEvent,
} from "../services/stripeWebhookEventService.js";
import {
    invalidateBusinessConfiguration,
    invalidateSetupProgress,
} from "../services/cacheInvalidationService.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

async function dispatchPaidOrderReceipt({ dispatcher, order, email }) {
    if (order.receiptEmail !== email) {
        order.receiptEmail = email;
        await order.save();
    }

    return dispatcher({
        businessId: order.businessId,
        orderId: order.orderId,
        directSend: async () => {
            const sent = await sendReceiptEmail(order, email, {
                idempotencyKey: getOrderReceiptIdempotencyKey(order),
            });
            if (sent) {
                order.receiptSent = true;
                order.receiptSentAt = new Date();
                await order.save();
            }
            return sent;
        },
    });
}

function getStoredCheckoutAmountCents(checkoutRecord) {
    const grossAmountCents = Number(checkoutRecord?.grossAmount);
    if (Number.isSafeInteger(grossAmountCents) && grossAmountCents > 0) {
        return grossAmountCents;
    }

    const total = Number(checkoutRecord?.total);
    const totalCents = Math.round(total * 100);
    return Number.isSafeInteger(totalCents) && totalCents > 0 ? totalCents : null;
}

export function validateOrderCheckoutPayment(session, checkoutRecord) {
    if (session?.payment_status !== "paid") {
        return {
            valid: false,
            code: "PAYMENT_NOT_PAID",
            reason: `checkout.session.completed has payment_status=${session?.payment_status || "missing"}`,
        };
    }

    const expectedAmountCents = getStoredCheckoutAmountCents(checkoutRecord);
    const stripeAmountCents = Number(session?.amount_total);
    if (expectedAmountCents === null) {
        return {
            valid: false,
            code: "INVALID_STORED_AMOUNT",
            reason: "stored checkout total is not a positive integer amount in cents",
            expectedAmountCents,
            stripeAmountCents,
        };
    }
    if (!Number.isSafeInteger(stripeAmountCents) || stripeAmountCents !== expectedAmountCents) {
        return {
            valid: false,
            code: "AMOUNT_MISMATCH",
            reason: `Stripe amount ${stripeAmountCents} does not match stored amount ${expectedAmountCents}`,
            expectedAmountCents,
            stripeAmountCents,
        };
    }

    const expectedCurrency = String(checkoutRecord?.currency || "").toLowerCase();
    const stripeCurrency = String(session?.currency || "").toLowerCase();
    if (!expectedCurrency || stripeCurrency !== expectedCurrency) {
        return {
            valid: false,
            code: "CURRENCY_MISMATCH",
            reason: `Stripe currency ${stripeCurrency || "missing"} does not match stored currency ${expectedCurrency || "missing"}`,
            expectedCurrency,
            stripeCurrency,
        };
    }

    return {
        valid: true,
        expectedAmountCents,
        stripeAmountCents,
        expectedCurrency,
        stripeCurrency,
    };
}

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

async function restoreBusinessAfterDurableBillingUpdate(biz) {
    if (!biz?.offlineServiceRestricted) return;
    const jobName = BILLING_JOB_NAMES.RESTORE_SERVICE;
    const periodKey = getBillingActionPeriodKey(jobName, biz);
    try {
        await processBillingLifecycleAction({
            jobName,
            businessId: biz.businessId,
            periodKey,
        });
    } catch (error) {
        // Billing lifecycle scheduler and manual cron recovery will retry.
        console.error("[webhook] Durable billing restoration follow-up failed", {
            businessId: biz.businessId,
            reason: error?.code || error?.name || "restoration_failed",
        });
    }
}

/**
 * POST /webhook/stripe
 */
export async function handleStripeWebhook(req, res) {
    const orderReceiptDispatcher =
        req.app?.locals?.dispatchAutomaticOrderReceipt ||
        dispatchAutomaticOrderReceipt;
    const sig = req.headers["stripe-signature"];
    let event = req.stripeWebhookEvent || null;

    try {
        if (!event) {
            event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        }
        console.log("[stripeWebhook] Signature verified", {
            eventId: event.id,
            eventType: event.type,
        });
    } catch (err) {
        console.error("[stripeWebhook] Signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === "account.updated") {
            const account = event.data.object;
            const chargesEnabled = account.charges_enabled === true;
            const payoutsEnabled = account.payouts_enabled === true;

            const business = await Business.findOneAndUpdate(
                { stripeAccountId: account.id },
                {
                    stripeChargesEnabled: chargesEnabled,
                    stripePayoutsEnabled: payoutsEnabled,
                    stripeOnboardingComplete: chargesEnabled && payoutsEnabled,
                }
            );

            if (business) {
                await invalidateSetupProgress(business.businessId);
            }

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
                            await Business.findOneAndUpdate(
                                { _id: biz._id },
                                { $set: updateFields }
                            );
                            await restoreBusinessAfterDurableBillingUpdate(biz);
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
                            await Business.findOneAndUpdate(
                                { _id: biz._id },
                                { $set: updateFields }
                            );
                            await restoreBusinessAfterDurableBillingUpdate(biz);
                        }
                    }

                    await invalidateBusinessConfiguration(biz.businessId);

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
                const failedAt = new Date();
                const stamped = await Business.findOneAndUpdate(
                    {
                        stripeSubscriptionId: invoice.subscription,
                        $or: [
                            { billingFailedAt: null },
                            { billingFailedAt: { $exists: false } },
                        ],
                    },
                    {
                        $set: {
                            billingStatus: 'past_due',
                            billingFailedAt: failedAt,
                        },
                    }
                );
                let fallbackBiz = null;
                if (!stamped) {
                    fallbackBiz = await Business.findOneAndUpdate(
                        { stripeSubscriptionId: invoice.subscription },
                        { $set: { billingStatus: 'past_due' } },
                    );
                }

                const affectedBusiness = stamped || fallbackBiz;
                if (affectedBusiness) {
                    await invalidateBusinessConfiguration(affectedBusiness.businessId);
                }
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
                }
                
                await Business.updateOne(
                    { _id: biz._id },
                    { $set: updateFields }
                );
                if (subscription.status === "active") {
                    await restoreBusinessAfterDurableBillingUpdate(biz);
                }
                await invalidateBusinessConfiguration(biz.businessId);
            }
            return res.status(200).send();
        }

        if ([
            "refund.created",
            "refund.updated",
            "refund.failed",
        ].includes(event.type)) {
            try {
                const result = await reconcileStripeReservationRefund({
                    providerRefund: event.data.object,
                });
                console.log("[webhook] Reservation refund reconciled", {
                    eventId: event.id,
                    eventType: event.type,
                    providerRefundId: event.data.object?.id || null,
                    ignored: Boolean(result?.ignored),
                });
                return res.status(200).send();
            } catch (error) {
                console.error("[webhook] Reservation refund reconciliation failed", {
                    eventId: event.id,
                    eventType: event.type,
                    providerRefundId: event.data.object?.id || null,
                    code: error?.code || null,
                    message: error?.message,
                });
                if (
                    error instanceof ReservationCancellationError &&
                    error.status < 500
                ) {
                    return res.status(error.status).send(error.code);
                }
                return res.status(500).send("Refund reconciliation failed");
            }
        }

        if (event.type !== "checkout.session.completed") {
            return res.status(200).send();
        }

        const session = event.data.object;
        const metadata = session.metadata || {};
        const {
            pendingCheckoutId,
            type: paymentType,
            reservationId,
            orderId: metadataOrderId,
            businessId: metadataBusinessId,
        } = metadata;

        console.log("[webhook] Checkout session received", {
            eventId: event.id,
            eventType: event.type,
            checkoutSessionId: session.id,
            pendingCheckoutId: pendingCheckoutId || null,
            orderId: metadataOrderId || null,
            businessId: metadataBusinessId || null,
            paymentStatus: session.payment_status || null,
        });

        // ── Reservation payment branch ──────────────────────────────────────────
        if (paymentType === "reservation_payment") {
            if (!reservationId) {
                console.error("[webhook] reservation_payment event missing reservationId in metadata", { sessionId: session.id });
                return res.status(200).send();
            }

            const reservation = await Reservation.findById(reservationId);
            if (!reservation) {
                console.error(`[webhook] Reservation not found: ${reservationId}`);
                return res.status(200).send();
            }

            // Idempotency guard
            if (reservation.paymentStatus === "paid") {
                console.log(`[webhook] Reservation ${reservationId} already marked paid — skipping duplicate event`);
                return res.status(200).send();
            }

            // Validate payment_status from Stripe (do not trust metadata amounts)
            if (session.payment_status !== "paid") {
                console.error(`[webhook] Reservation ${reservationId} checkout.session.completed but payment_status=${session.payment_status}`);
                return res.status(200).send();
            }

            // Validate amount: Stripe amount_total (cents) must match stored grossAmount
            const storedAmountCents = Number(reservation.grossAmount);
            const stripeAmountCents = Number(session.amount_total);
            if (!Number.isSafeInteger(storedAmountCents) || storedAmountCents <= 0) {
                console.error(`[webhook] Reservation ${reservationId} has invalid stored grossAmount: ${storedAmountCents}`);
                return res.status(200).send();
            }
            if (stripeAmountCents !== storedAmountCents) {
                console.error(`[webhook] Reservation ${reservationId} amount mismatch — stripe=${stripeAmountCents} stored=${storedAmountCents}`);
                return res.status(200).send();
            }

            // Validate currency
            const storedCurrency = (reservation.currency || "").toLowerCase();
            const stripeCurrency = (session.currency || "").toLowerCase();
            if (stripeCurrency !== storedCurrency) {
                console.error(`[webhook] Reservation ${reservationId} currency mismatch — stripe=${stripeCurrency} stored=${storedCurrency}`);
                return res.status(200).send();
            }

            // Persist the payment truth with one tenant-scoped conditional update.
            const paidAt = new Date();
            const paymentTransition = await confirmReservationPaymentAtomic({
                reservationId: reservation._id,
                businessId: reservation.businessId,
                expectedAmountCents: stripeAmountCents,
                expectedCurrency: storedCurrency,
                checkoutSessionId: session.id,
                paymentIntentId: session.payment_intent || null,
                confirmedAt: paidAt,
            });
            if (!paymentTransition.transitioned) {
                if (paymentTransition.alreadyPaid) return res.status(200).send();
                console.error("[webhook] Reservation payment transition lost its conditional state", {
                    reservationId,
                    businessId: reservation.businessId,
                });
                return res.status(409).send("Reservation payment state changed");
            }
            const paidReservation = paymentTransition.reservation;
            console.log(`[webhook] Reservation ${reservationId} marked paid — session=${session.id}`);

            // Fetch business for email / check-in credential generation
            const resBusiness = await Business.findOne({ businessId: paidReservation.businessId }).lean();
            if (resBusiness) {
                try {
                    // generateHotelCheckInCredentials sends the post-payment confirmation
                    // email (with check-in code) via sendHotelPaymentConfirmationEmail.
                    await generateHotelCheckInCredentials(paidReservation, resBusiness);
                } catch (emailErr) {
                    // Credentials are stored — email failure is non-fatal here.
                    console.error(`[webhook] Check-in credential/email error for reservation ${reservationId}:`, {
                        name: emailErr.name,
                        message: emailErr.message,
                    });
                }
            } else {
                console.error(`[webhook] Business not found for reservation ${reservationId} — skipping post-payment email`);
            }

            return res.status(200).send();
        }

        // ── Order payment branch (pendingCheckoutId) ────────────────────────────
        if (!pendingCheckoutId) {
            console.error("[webhook] checkout.session.completed missing pendingCheckoutId in metadata", { sessionId: session.id });
            return res.status(200).send();
        }

        const pending = await PendingCheckout.findById(pendingCheckoutId);

        if (!pending) {
            const existingOrder = metadataBusinessId && metadataOrderId
                ? await Order.findOne({ businessId: metadataBusinessId, orderId: metadataOrderId })
                : null;

            if (!existingOrder) {
                console.error("[webhook] PendingCheckout not found and no paid order could be resolved", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    pendingCheckoutId,
                    orderId: metadataOrderId || null,
                    businessId: metadataBusinessId || null,
                });
                return res.status(200).send();
            }

            if (existingOrder.stripeSessionId && existingOrder.stripeSessionId !== session.id) {
                console.error("[webhook] Existing order Stripe session mismatch", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                });
                return res.status(400).send("Checkout session mismatch");
            }

            const validation = validateOrderCheckoutPayment(session, existingOrder);
            if (!validation.valid) {
                console.error("[webhook] Existing paid order validation failed", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                    code: validation.code,
                    reason: validation.reason,
                });
                return res.status(400).send(validation.code);
            }

            if (existingOrder.paymentStatus !== "paid") {
                console.error("[webhook] PendingCheckout is missing and resolved order is not paid", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                    paymentStatus: existingOrder.paymentStatus,
                });
                return res.status(500).send("Paid order state is incomplete");
            }

            const retryEmail = existingOrder.receiptEmail || session.customer_details?.email || null;
            if (existingOrder.receiptSentAt || existingOrder.receiptSent) {
                console.log("[webhook] Duplicate order payment already has a recorded receipt", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                });
                return res.status(200).send();
            }

            if (!retryEmail) {
                console.warn("[webhook] Paid order has no customer email for receipt retry", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                });
                return res.status(200).send();
            }

            console.log("[webhook] Dispatching receipt for previously processed payment", {
                eventId: event.id,
                checkoutSessionId: session.id,
                orderId: existingOrder.orderId,
                businessId: existingOrder.businessId,
            });
            const receiptDelivery = await dispatchPaidOrderReceipt({
                dispatcher: orderReceiptDispatcher,
                order: existingOrder,
                email: retryEmail,
            });
            if (receiptDelivery.mode === "direct" && !receiptDelivery.success) {
                console.error("[webhook] Receipt retry failed for previously processed payment", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId: existingOrder.orderId,
                    businessId: existingOrder.businessId,
                });
                return res.status(500).send("Receipt delivery failed");
            }

            console.log("[webhook] Receipt retry dispatched", {
                eventId: event.id,
                checkoutSessionId: session.id,
                orderId: existingOrder.orderId,
                businessId: existingOrder.businessId,
                mode: receiptDelivery.mode,
                queued: receiptDelivery.queued || false,
            });
            return res.status(200).send();
        }

        if (!pending.businessId) {
            console.error(`[webhook] PendingCheckout missing businessId: ${pendingCheckoutId}`);
            return res.status(200).send();
        }

        const businessId = pending.businessId;
        const orderId = pending.orderId || generateOrderId(pending.tableNumber);

        if (
            (metadataBusinessId && metadataBusinessId !== businessId) ||
            (metadataOrderId && metadataOrderId !== orderId)
        ) {
            console.error("[webhook] Stripe metadata does not match PendingCheckout", {
                eventId: event.id,
                checkoutSessionId: session.id,
                pendingCheckoutId,
                orderId,
                businessId,
            });
            return res.status(400).send("Checkout metadata mismatch");
        }

        if (pending.stripeSessionId && pending.stripeSessionId !== session.id) {
            console.error("[webhook] Stripe session does not match PendingCheckout", {
                eventId: event.id,
                checkoutSessionId: session.id,
                pendingCheckoutId,
                orderId,
                businessId,
            });
            return res.status(400).send("Checkout session mismatch");
        }

        const paymentValidation = validateOrderCheckoutPayment(session, pending);
        if (!paymentValidation.valid) {
            console.error("[webhook] Food-order payment validation failed", {
                eventId: event.id,
                checkoutSessionId: session.id,
                pendingCheckoutId,
                orderId,
                businessId,
                paymentStatus: session.payment_status || null,
                code: paymentValidation.code,
                reason: paymentValidation.reason,
                expectedAmountCents: paymentValidation.expectedAmountCents,
                stripeAmountCents: paymentValidation.stripeAmountCents,
                expectedCurrency: paymentValidation.expectedCurrency,
                stripeCurrency: paymentValidation.stripeCurrency,
            });
            return res.status(400).send(paymentValidation.code);
        }

        console.log("[webhook] Food-order payment validated", {
            eventId: event.id,
            checkoutSessionId: session.id,
            pendingCheckoutId,
            orderId,
            businessId,
            paymentStatus: session.payment_status,
            amountTotalCents: paymentValidation.stripeAmountCents,
            currency: paymentValidation.stripeCurrency,
        });

        // Idempotency guard — do not create duplicate orders on Stripe retry
        let order = await Order.findOne({ businessId, orderId });
        let receiptDeliveryFailed = false;

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

            const customerEmail = pending.receiptEmail || session.customer_details?.email || order.receiptEmail || null;

            if (customerEmail && order.receiptEmail !== customerEmail) {
                order.receiptEmail = customerEmail;
                updated = true;
            }

            // Persist the final paid order state before rendering or sending its receipt.
            if (updated) {
                await order.save();
            }

            if (customerEmail && !order.receiptSentAt && !order.receiptSent) {
                console.log("[webhook] Dispatching paid-order receipt", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    pendingCheckoutId,
                    orderId,
                    businessId,
                    paymentStatus: order.paymentStatus,
                });
                try {
                    const receiptDelivery = await dispatchPaidOrderReceipt({
                        dispatcher: orderReceiptDispatcher,
                        order,
                        email: customerEmail,
                    });
                    if (receiptDelivery.mode === "direct" && receiptDelivery.success) {
                        updated = true;
                        console.log("[webhook] Receipt accepted by provider", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                        });
                    } else if (receiptDelivery.mode === "direct") {
                        receiptDeliveryFailed = true;
                        console.error("[webhook] Receipt provider rejected or failed the send", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                        });
                    } else {
                        console.log("[webhook] Receipt delivery intent recorded", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                            queued: receiptDelivery.queued || false,
                        });
                    }
                } catch (err) {
                    receiptDeliveryFailed = true;
                    console.error("[webhook] Receipt send error", {
                        eventId: event.id,
                        checkoutSessionId: session.id,
                        orderId,
                        businessId,
                        name: err.name,
                        message: err.message,
                        stack: err.stack,
                    });
                }
            } else if (!customerEmail) {
                console.warn("[webhook] Paid order has no customer email; receipt sender not called", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId,
                    businessId,
                });
            } else {
                console.log("[webhook] Receipt already recorded; sender not called", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId,
                    businessId,
                });
            }

            if (updated) {
                // Notify waiter/table that the order was paid online
                const orderDTO = toOrderDTO(order);
                await publishEvent("order_updated", businessId, ["waiter", "table"], { order: orderDTO });
            }

            if (customerEmail && !order.crmProcessed) {
                try {
                    const intent = await recordCrmOrderIntent({
                        businessId,
                        orderId: order.orderId,
                        email: customerEmail,
                    });
                    if (intent.recorded) {
                        void dispatchCrmOrder({ businessId, orderId: order.orderId });
                    }
                } catch (crmError) {
                    // The paid Order is already durable. Repair scanning will
                    // discover it by receiptEmail without failing the webhook.
                    console.error("[webhook] CRM intent recording failed", {
                        businessId,
                        orderId: order.orderId,
                        reason: crmError?.code || crmError?.name || "crm_intent_failed",
                    });
                }
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
            let displayLabel = pending.displayLabel || "";
            if (!displayLabel) {
                const sp = await ServicePoint.findOne({ servicePointId: pending.servicePointLabel, businessId }).lean();
                displayLabel = sp?.label || sp?.code || pending.servicePointLabel;
            }

            console.log(`[webhook] Creating new Order for orderId=${orderId}, subtotal=${pending.subtotal}, taxAmount=${pending.taxAmount}, tipAmount=${pending.tipAmount}, total=${pending.total}`);
            order = await Order.create({
                businessId,
                orderId,
                servicePointLabel: pending.servicePointLabel,
                displayLabel: displayLabel,
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
                crmEmail: customerEmail ? customerEmail.toLowerCase().trim() : null,
                crmProcessingStatus: customerEmail ? "pending" : null,
                crmProcessingRetryable: true,
            });

            await invalidateSetupProgress(businessId);

            console.log(`[webhook] Order created: orderId=${orderId}, businessId=${businessId}`);

            if (customerEmail) {
                console.log("[webhook] Dispatching paid-order receipt", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    pendingCheckoutId,
                    orderId,
                    businessId,
                    paymentStatus: order.paymentStatus,
                });
                try {
                    const receiptDelivery = await dispatchPaidOrderReceipt({
                        dispatcher: orderReceiptDispatcher,
                        order,
                        email: customerEmail,
                    });
                    if (receiptDelivery.mode === "direct" && receiptDelivery.success) {
                        console.log("[webhook] Receipt accepted by provider", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                        });
                    } else if (receiptDelivery.mode === "direct") {
                        receiptDeliveryFailed = true;
                        console.error("[webhook] Receipt provider rejected or failed the send", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                        });
                    } else {
                        console.log("[webhook] Receipt delivery intent recorded", {
                            eventId: event.id,
                            checkoutSessionId: session.id,
                            orderId,
                            businessId,
                            queued: receiptDelivery.queued || false,
                        });
                    }
                } catch (err) {
                    receiptDeliveryFailed = true;
                    console.error("[webhook] Receipt send error", {
                        eventId: event.id,
                        checkoutSessionId: session.id,
                        orderId,
                        businessId,
                        name: err.name,
                        message: err.message,
                        stack: err.stack,
                    });
                }
            } else {
                console.warn("[webhook] Paid order has no customer email; receipt sender not called", {
                    eventId: event.id,
                    checkoutSessionId: session.id,
                    orderId,
                    businessId,
                });
            }

            if (customerEmail) {
                void dispatchCrmOrder({ businessId, orderId: order.orderId });
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

        if (receiptDeliveryFailed) {
            console.error("[webhook] Food-order payment completed but receipt delivery failed; preserving PendingCheckout for retry", {
                eventId: event.id,
                checkoutSessionId: session.id,
                pendingCheckoutId,
                orderId,
                businessId,
                paymentStatus: order.paymentStatus,
            });
            return res.status(500).send("Receipt delivery failed");
        }

        await PendingCheckout.findByIdAndDelete(pendingCheckoutId);

        console.log("[webhook] Food-order payment processing completed", {
            eventId: event.id,
            checkoutSessionId: session.id,
            pendingCheckoutId,
            orderId,
            businessId,
            paymentStatus: order.paymentStatus,
            receiptSent: Boolean(order.receiptSentAt || order.receiptSent),
        });

        return res.status(200).send();
    } catch (error) {
        console.error("[stripeWebhook] Error processing webhook:", error.message, error.stack);
        return res.status(500).send("Internal Server Error");
    }
}

function createDeferredWebhookResponse() {
    return {
        statusCode: 200,
        body: undefined,
        responseType: "send",
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            this.responseType = "send";
            return this;
        },
        json(body) {
            this.body = body;
            this.responseType = "json";
            return this;
        },
    };
}

/**
 * Production wrapper: signature verification and Mongo claim stay synchronous,
 * and Stripe is acknowledged only after the event claim is durably completed.
 */
export async function handleDurableStripeWebhook(req, res) {
    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            req.headers["stripe-signature"],
            endpointSecret,
        );
    } catch (error) {
        console.error("[stripeWebhook] Signature verification failed:", error.message);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    const claimEvent = req.app?.locals?.claimStripeWebhookEvent ||
        claimStripeWebhookEvent;
    const completeEvent = req.app?.locals?.completeStripeWebhookEvent ||
        completeStripeWebhookEvent;
    let claim;
    try {
        claim = await claimEvent({ eventId: event.id, eventType: event.type });
    } catch (error) {
        console.error("[stripeWebhook] Durable event claim failed", {
            eventId: event.id,
            reason: error?.code || error?.name || "claim_failed",
        });
        return res.status(500).send("Webhook claim failed");
    }
    if (!claim.claimed) {
        if (claim.reason === "already_processed") return res.status(200).send();
        return res.status(503).send("Webhook event is already processing");
    }

    const deferred = createDeferredWebhookResponse();
    req.stripeWebhookEvent = event;
    await handleStripeWebhook(req, deferred);
    const failed = deferred.statusCode >= 500;
    try {
        await completeEvent({
            eventId: event.id,
            claimId: claim.claimId,
            status: failed ? "failed" : "processed",
            error: failed ? String(deferred.body || "webhook processing failed") : null,
        });
    } catch (error) {
        console.error("[stripeWebhook] Durable event completion failed", {
            eventId: event.id,
            reason: error?.code || error?.name || "completion_failed",
        });
        return res.status(500).send("Webhook completion claim failed");
    }
    const target = res.status(deferred.statusCode);
    return deferred.responseType === "json"
        ? target.json(deferred.body)
        : target.send(deferred.body);
}
