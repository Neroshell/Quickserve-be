import Stripe from "stripe";
import GuestSession from "../models/GuestSession.js";
import PendingCheckout from "../models/PendingCheckout.js";
import { resolveOrStartCustomerJourney } from "../services/customerJourneyService.js";
import Reservation from "../models/Reservation.js";
import Business from "../models/Business.js";
import MenuItem from "../models/menuItem.js";
import ServicePoint from "../models/ServicePoint.js";
import { generateOrderId } from "../utils/orderId.js";
import { calculateOnlinePricing } from "../services/pricingService.js";
import {
    buildReservationStripeLineItems,
    ensureReservationPricingSnapshot,
    getCustomerReservationPricing,
} from "../services/reservationPricingService.js";
import { validateTrackedStock } from "../services/inventoryService.js";
import { getItemPrepTimeMinutes } from "../utils/orderEstimate.js";
import { normalizeTip } from "../utils/tips.js";
import { getPendingCheckoutExpiresAt } from "../constants/checkoutRetention.js";
// Restaurant-flow defect safeguards for online checkout:
// validate and normalize the cart, reject disabled business/order/payment modes,
// and derive Stripe currency from the business instead of the client request.
import {
    getBusinessCurrency,
    getOrderItemsValidationError,
    isBusinessServable,
    isOrderTypeEnabled,
    isPaymentChannelEnabled,
    normalizeOrderItems,
} from "../utils/restaurantOrderValidation.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

/**
 * POST /payments/checkout
 *
 * Validates the request, stores cart data in PendingCheckout (temporary),
 * creates a Stripe Checkout Session, and returns the Stripe-hosted URL.
 *
 * NO Order is created here. The Order is only created by the webhook
 * after Stripe confirms the payment is successful.
 */
export async function createCheckoutSession(req, res) {
    try {
        const {
            servicePointLabel,
            items,
            sessionId,
            tableSessionToken,
            orderType,
            receiptEmail,
            tipAmount,
            tipType,
            tipPercentage,
            journeyId,
        } = req.body;

        // --- Validation ---
        const isWaiter = req.session?.user?.role === "waiter" || req.session?.user?.role === "owner" || req.session?.user?.role === "manager";

        if (!isWaiter && !sessionId)
            return res.status(400).json({ message: "sessionId is required" });
        if (!isWaiter && !tableSessionToken)
            return res.status(400).json({ message: "tableSessionToken is required" });
        if (!servicePointLabel || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ message: "servicePointLabel and items are required" });
        const itemValidationError = getOrderItemsValidationError(items);
        if (itemValidationError)
            return res.status(400).json({ message: itemValidationError });
        const normalizedItems = normalizeOrderItems(items);

        const allowedTypes = ["dine-in", "takeout"];
        const finalOrderType = orderType || "dine-in";
        if (!allowedTypes.includes(finalOrderType))
            return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` });

        let businessIdToUse;

        if (!isWaiter) {
            // --- Validate table session token ---
            const ts = await GuestSession.findOne({ token: tableSessionToken });
            if (!ts)
                return res.status(403).json({ message: "Invalid or expired table session." });
            if (ts.expiresAt.getTime() < Date.now())
                return res.status(403).json({ message: "Session expired." });
            if (ts.servicePointId !== servicePointLabel)
                return res.status(403).json({ message: "Table session mismatch." });

            // Bind session to first device ATOMICALLY
            if (!ts.boundSessionId) {
                const updatedTs = await GuestSession.findOneAndUpdate(
                    { _id: ts._id, boundSessionId: null },
                    { $set: { boundSessionId: sessionId } },
                    { new: true }
                );
                if (!updatedTs) {
                    return res.status(403).json({ message: "Table session was just claimed by another device." });
                }
                ts.boundSessionId = sessionId;
            } else if (ts.boundSessionId !== sessionId) {
                return res.status(403).json({ message: "Table session active on another device." });
            }
            businessIdToUse = ts.businessId;
        } else {
            businessIdToUse = req.session.user.businessId;
            if (!businessIdToUse) {
                return res.status(403).json({ message: "Unauthorized: Missing businessId in session" });
            }
        }

        const business = await Business.findOne({
            $or: [{ businessId: businessIdToUse }, { businessId: businessIdToUse }],
        }).lean();

        if (!isBusinessServable(business)) {
            return res.status(404).json({ message: "Business not found or inactive" });
        }
        if (!isOrderTypeEnabled(business, finalOrderType)) {
            return res.status(403).json({
                message: `${finalOrderType === "takeout" ? "Takeout" : "Dine-in"} ordering is disabled for this business.`,
            });
        }
        if (!isPaymentChannelEnabled(business, "online")) {
            return res.status(403).json({
                message: "Online payments are disabled for this business.",
            });
        }
        if (
            !business.stripeAccountId ||
            business.stripeChargesEnabled !== true ||
            business.stripePayoutsEnabled !== true
        ) {
            return res.status(400).json({
                message: "Online payments are not available for this business yet. Please ask staff for assistance.",
            });
        }

        const sp = await ServicePoint.findOne({
            servicePointId: servicePointLabel,
            businessId: businessIdToUse,
        }).lean();
        if (!sp || sp.isActive === false) {
            return res.status(400).json({
                message: "This ServicePoint is not active for the selected business.",
            });
        }

        // --- Build Stripe line items and enrich cart items ---
        const lineItems = [];
        const enrichedItems = [];
        let serverTotal = 0;
        const finalCurrency = getBusinessCurrency(business).toLowerCase();

        for (const item of normalizedItems) {
            const qty = item.quantity;

            // Price is ALWAYS taken from the database, never from the client.
            // This prevents checkout manipulation (e.g. sending price: 0.01).
            const menuItem = await MenuItem.findOne({
                name: item.itemName,
                businessId: businessIdToUse,
            }).lean();

            if (!menuItem || menuItem.isAvailable === false) {
                return res.status(400).json({ message: `Menu item '${item.itemName}' is no longer available.` });
            }

            const price = Number(menuItem.price) || 0;
            const priceInCents = Math.round(price * 100);

            serverTotal += price * qty;

            lineItems.push({
                price_data: {
                    currency: finalCurrency,
                    product_data: { name: menuItem.name },
                    unit_amount: priceInCents,
                },
                quantity: qty,
            });

            enrichedItems.push({
                menuItemId: menuItem._id,
                itemName: menuItem.name,
                quantity: qty,
                lineTotal: Number((price * qty).toFixed(2)),
                prepTimeMinutes: getItemPrepTimeMinutes(menuItem),
                type: menuItem.type || (item.orderCategory === "drinks" ? "drinks" : "food"),
                category: menuItem.category || "mains",
                notes: item.notes || "",
                allergies: item.allergies || [],
            });
        }

        // --- Validate stock before touching Stripe or PendingCheckout ---
        const stockFailures = await validateTrackedStock(enrichedItems, businessIdToUse);
        if (stockFailures.length > 0) {
            return res.status(400).json({
                message: "Some items are no longer available in the requested quantity.",
                items: stockFailures,
            });
        }

        // --- Resolve service point label for display ---
        // servicePointLabel is the internal servicePointId (e.g. sp_xxxx); we resolve the
        // human-friendly label once here so the webhook can copy it without a second lookup.
        const displayLabel = sp?.label || sp?.code || servicePointLabel;
        const servicePointQrCode = sp?.code || sp?.label || displayLabel;

        // --- Save cart data temporarily (not an Order yet) ---
        const now = new Date();
        const orderId = generateOrderId(servicePointQrCode, now);

        const subtotal = Number(serverTotal.toFixed(2));
        const tip = normalizeTip({
            tipsEnabled: business.settings?.tipsEnabled === true || business.tipsEnabled === true,
            subtotal,
            tipAmount,
            tipType,
            tipPercentage,
        });
        const tipAmountCents = Math.round(tip.tipAmount * 100);
        const subtotalCents = Math.round(serverTotal * 100);
        const pricing = await calculateOnlinePricing({
            subtotalCents,
            business,
            tipAmountCents,
        });
        const {
            taxAmount,
            taxAmountCents,
            commissionAmountCents,
            commissionRateApplied,
            planApplied,
            customerPlatformFeeCents,
            businessAbsorbedPlatformFeeCents,
            platformFeeMode,
            customerPlatformFeePercent,
        } = pricing;

        if (taxAmountCents > 0) {
            lineItems.push({
                price_data: {
                    currency: finalCurrency,
                    product_data: { name: pricing.taxLabel },
                    unit_amount: taxAmountCents,
                },
                quantity: 1,
            });
        }

        if (tipAmountCents > 0) {
            lineItems.push({
                price_data: {
                    currency: finalCurrency,
                    product_data: { name: "Tip" },
                    unit_amount: tipAmountCents,
                },
                quantity: 1,
            });
        }

        // Resolve or start canonical CustomerJourney
        const journey = await resolveOrStartCustomerJourney({
            businessId: businessIdToUse,
            journeyId: journeyId || null,
            tableSessionToken,
            sessionId,
            servicePointId: servicePointLabel,
            orderType: finalOrderType,
        });
        const resolvedJourneyId = journey?.journeyId || null;

        const pending = await PendingCheckout.create({
            businessId: businessIdToUse,
            orderId,
            servicePointLabel,   // internal servicePointId — preserved for routing
            displayLabel,        // human-friendly — copied to Order by webhook
            orderType: finalOrderType,
            sessionId,
            items: enrichedItems,
            subtotal,
            taxAmount,
            tipAmount: tip.tipAmount,
            tipType: tip.tipType,
            tipPercentage: tip.tipPercentage,
            total: subtotal + taxAmount + tip.tipAmount,
            currency: finalCurrency.toUpperCase(),
            receiptEmail: receiptEmail || null,
            journeyId: resolvedJourneyId,
        });

        if (customerPlatformFeeCents > 0) {
            lineItems.push({
                price_data: {
                    currency: finalCurrency,
                    product_data: { name: pricing.platformFeeLabel },
                    unit_amount: customerPlatformFeeCents,
                },
                quantity: 1,
            });
        }

        // --- Create Stripe Checkout Session (Connect destination charge) ---
        const stripeSessionConfig = {
            payment_method_types: ["card"],
            mode: "payment",
            line_items: lineItems,
            metadata: {
                pendingCheckoutId: pending._id.toString(),
                orderId,
                servicePointLabel: displayLabel,
                businessId: businessIdToUse,
            },
            // Route payment to connected account; platform fee stays with QuickServe
            payment_intent_data: {
                application_fee_amount: commissionAmountCents,
                transfer_data: {
                    destination: business.stripeAccountId,
                },
                metadata: {
                    orderId,
                    businessId: businessIdToUse,
                },
            },
            success_url: `${FRONTEND_BASE_URL}/s/${servicePointLabel}/confirmation?payment=success&orderId=${orderId}&businessId=${businessIdToUse}`,
            cancel_url: `${FRONTEND_BASE_URL}/s/${servicePointLabel}/order?payment=cancelled&businessId=${businessIdToUse}`,
        };

        if (receiptEmail) {
            stripeSessionConfig.customer_email = receiptEmail;
        }

        const stripeClient = req.app?.locals?.stripe || stripe;
        const stripeSession = await stripeClient.checkout.sessions.create(stripeSessionConfig);

        console.log(`[checkout] Stripe session created — sessionId=${stripeSession.id}`);

        pending.stripeSessionId = stripeSession.id;
        pending.stripeExpiresAt = stripeSession.expires_at !== null &&
            stripeSession.expires_at !== undefined &&
            Number.isFinite(Number(stripeSession.expires_at))
            ? new Date(Number(stripeSession.expires_at) * 1000)
            : null;
        pending.expiresAt = getPendingCheckoutExpiresAt({
            stripeExpiresAt: stripeSession.expires_at,
        });
        pending.stripePaymentIntentId = stripeSession.payment_intent || null;
        pending.stripeConnectedAccountId = business.stripeAccountId;
        pending.commissionAmountCents = commissionAmountCents;
        pending.commissionRateApplied = commissionRateApplied;
        pending.planApplied = planApplied;
        pending.planAtOrder = planApplied;
        pending.commissionRateAtOrder = commissionRateApplied;
        pending.platformFeeRateAtOrder = commissionRateApplied;

        pending.platformFeeCents = commissionAmountCents;
        pending.customerPlatformFeeCents = customerPlatformFeeCents;
        pending.businessAbsorbedPlatformFeeCents = businessAbsorbedPlatformFeeCents;
        pending.platformFeeMode = platformFeeMode;
        pending.customerPlatformFeePercent = customerPlatformFeePercent;

        pending.grossAmount = pricing.grossAmountCents;
        pending.netToBusinessAmount = pricing.netToBusinessAmountCents;
        pending.total = pricing.total;
        await pending.save();

        return res.status(201).json({
            sessionUrl: stripeSession.url,
            journeyId: resolvedJourneyId,
        });
    } catch (err) {
        console.error("[createCheckoutSession] Error:", err);
        return res.status(500).json({ message: "Server error creating checkout session" });
    }
}

/**
 * POST /payments/checkout-reservation
 * 
 * Creates a Stripe Checkout Session for a hotel reservation.
 */
export async function createReservationCheckoutSession(req, res) {
    try {
        const { secureToken } = req.body;

        if (!secureToken) {
            return res.status(400).json({ message: "secureToken is required" });
        }

        const reservation = await Reservation.findOne({ secureToken });
        if (!reservation) {
            return res.status(404).json({ message: "Reservation not found" });
        }

        if (reservation.status !== "accepted_awaiting_payment") {
            return res.status(400).json({ message: "Reservation is not awaiting payment" });
        }

        if (reservation.paymentExpiresAt && new Date(reservation.paymentExpiresAt) < new Date()) {
            reservation.status = "expired";
            await reservation.save();
            return res.status(400).json({ message: "Payment link has expired" });
        }

        const business = await Business.findOne({ businessId: reservation.businessId }).lean();
        if (!business) {
            return res.status(404).json({ message: "Business not found" });
        }

        if (
            !business.stripeAccountId ||
            business.stripeChargesEnabled !== true ||
            business.stripePayoutsEnabled !== true
        ) {
            return res.status(400).json({ message: "Online payments are not available for this business." });
        }

        await ensureReservationPricingSnapshot({ reservation, business });
        const pricing = getCustomerReservationPricing(reservation);

        if (!pricing.totalCents || pricing.totalCents <= 0) {
            return res.status(400).json({
                success: false,
                message: "This reservation does not have a valid payment amount. Please contact the business.",
            });
        }

        const amountCents = pricing.totalCents;
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment amount",
            });
        }

        const currency = (business.currency || reservation.currency || "eur").toLowerCase();
        const lineItems = buildReservationStripeLineItems({
            pricing,
            currency,
            businessName: business.displayName || business.name,
        });

        const stripeSessionConfig = {
            payment_method_types: ["card"],
            mode: "payment",
            line_items: lineItems,
            metadata: {
                reservationId: reservation._id.toString(),
                businessId: business.businessId,
                type: "reservation_payment",
                pricingSnapshotVersion: String(reservation.pricingSnapshotVersion),
            },
            payment_intent_data: {
                application_fee_amount: reservation.commissionAmountCents,
                transfer_data: { destination: business.stripeAccountId },
                metadata: {
                    reservationId: reservation._id.toString(),
                    businessId: business.businessId,
                    type: "reservation_payment"
                },
            },
            success_url: `${FRONTEND_BASE_URL}/reservation/confirmation/${reservation._id}`,
            cancel_url: `${FRONTEND_BASE_URL}/reservation/pay/${secureToken}?payment=cancelled`,
        };

        if (reservation.email) {
            stripeSessionConfig.customer_email = reservation.email;
        }

        const stripeSession = await stripe.checkout.sessions.create(stripeSessionConfig);

        reservation.stripeSessionId = stripeSession.id;
        reservation.stripeConnectedAccountId = business.stripeAccountId;
        await reservation.save();

        return res.status(201).json({ sessionUrl: stripeSession.url });
    } catch (err) {
        console.error("[createReservationCheckoutSession] Error:", err);
        return res.status(500).json({ message: "Server error creating reservation checkout session" });
    }
}
