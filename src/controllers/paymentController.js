import Stripe from "stripe";
import TableSession from "../models/TableSession.js";
import PendingCheckout from "../models/PendingCheckout.js";
import Business from "../models/Business.js";
import MenuItem from "../models/menuItem.js";
import ServicePoint from "../models/ServicePoint.js";
import { generateOrderId } from "../utils/orderId.js";
import { calculatePlatformFee, getFeeRate } from "../utils/platformFee.js";

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
            tableNumber,
            items,
            sessionId,
            tableSessionToken,
            orderType,
            currency,
            receiptEmail,
        } = req.body;

        // --- Validation ---
        const isWaiter = req.session?.user?.role === "waiter" || req.session?.user?.role === "owner" || req.session?.user?.role === "manager";

        if (!isWaiter && !sessionId)
            return res.status(400).json({ message: "sessionId is required" });
        if (!isWaiter && !tableSessionToken)
            return res.status(400).json({ message: "tableSessionToken is required" });
        if (!tableNumber || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ message: "tableNumber and items are required" });

        const allowedTypes = ["dine-in", "takeout"];
        const finalOrderType = orderType || "dine-in";
        if (!allowedTypes.includes(finalOrderType))
            return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` });

        let businessIdToUse;

        if (!isWaiter) {
            // --- Validate table session token ---
            const ts = await TableSession.findOne({ token: tableSessionToken });
            if (!ts)
                return res.status(403).json({ message: "Invalid or expired table session." });
            if (ts.expiresAt.getTime() < Date.now())
                return res.status(403).json({ message: "Session expired." });
            if (ts.tableId !== tableNumber)
                return res.status(403).json({ message: "Table session mismatch." });

            // Bind session to first device ATOMICALLY
            if (!ts.boundSessionId) {
                const updatedTs = await TableSession.findOneAndUpdate(
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

        // --- Build Stripe line items and enrich cart items ---
        const lineItems = [];
        const enrichedItems = [];
        let serverTotal = 0;
        const finalCurrency = (currency || "eur").toLowerCase();

        for (const item of items) {
            const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));

            // Price is ALWAYS taken from the database, never from the client.
            // This prevents checkout manipulation (e.g. sending price: 0.01).
            const menuItem = await MenuItem.findOne({
                name: item.itemName,
                businessId: businessIdToUse,
            }).lean();

            if (!menuItem) {
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
                itemName: menuItem.name,
                quantity: qty,
                lineTotal: Number((price * qty).toFixed(2)),
                type: menuItem.type || (item.orderCategory === "drinks" ? "drinks" : "food"),
                category: menuItem.category || "mains",
                notes: item.notes || "",
                allergies: item.allergies || [],
            });
        }

        // --- Resolve business and check Stripe Connect readiness ---
        const business = await Business.findOne({
            $or: [{ businessId: businessIdToUse }, { restaurantId: businessIdToUse }],
        }).lean();

        if (!business) {
            return res.status(404).json({ message: "Business not found" });
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

        // --- Resolve service point label for display ---
        // tableNumber is the internal servicePointId (e.g. sp_xxxx); we resolve the
        // human-friendly label once here so the webhook can copy it without a second lookup.
        const sp = await ServicePoint.findOne({ servicePointId: tableNumber, businessId: businessIdToUse }).lean();
        const tableLabel = sp?.label || sp?.code || tableNumber;
        const tableCode  = sp?.code  || sp?.label || tableNumber;

        // --- Save cart data temporarily (not an Order yet) ---
        const now = new Date();
        const orderId = generateOrderId(tableCode, now);

        const pending = await PendingCheckout.create({
            businessId: businessIdToUse,
            orderId,
            tableNumber,   // internal servicePointId — preserved for routing
            tableLabel,    // human-friendly — copied to Order by webhook
            orderType: finalOrderType,
            sessionId,
            items: enrichedItems,
            total: Number(serverTotal.toFixed(2)),
            currency: finalCurrency.toUpperCase(),
            receiptEmail: receiptEmail || null,
        });

        // --- Compute platform fee (plan-based rate) ---
        const totalInCents = Math.round(serverTotal * 100);
        const applicationFeeAmount = calculatePlatformFee(totalInCents, business.plan);

        console.log(
            `[createCheckoutSession] Plan=${business.plan}, total=${totalInCents}c, fee=${applicationFeeAmount}c (${((applicationFeeAmount / totalInCents) * 100).toFixed(2)}%)`
        );

        // --- Create Stripe Checkout Session (Connect destination charge) ---
        const stripeSessionConfig = {
            payment_method_types: ["card"],
            mode: "payment",
            line_items: lineItems,
            metadata: {
                pendingCheckoutId: pending._id.toString(),
                orderId,
                tableNumber,
                businessId: businessIdToUse,
            },
            // Route payment to connected account; platform fee stays with QuickServe
            payment_intent_data: {
                application_fee_amount: applicationFeeAmount,
                transfer_data: {
                    destination: business.stripeAccountId,
                },
                metadata: {
                    orderId,
                    businessId: businessIdToUse,
                },
            },
            success_url: `${FRONTEND_BASE_URL}/table/${tableNumber}/confirmation?payment=success&orderId=${orderId}&businessId=${businessIdToUse}`,
            cancel_url: `${FRONTEND_BASE_URL}/table/${tableNumber}/order?payment=cancelled&businessId=${businessIdToUse}`,
        };

        if (receiptEmail) {
            stripeSessionConfig.customer_email = receiptEmail;
        }

        const stripeSession = await stripe.checkout.sessions.create(stripeSessionConfig);

        console.log(`[checkout] Stripe session created — sessionId=${stripeSession.id}`);

        // Save Stripe session ID + full split metadata on the pending record
        const feeRate = getFeeRate(business.plan);
        pending.stripeSessionId          = stripeSession.id;
        pending.stripePaymentIntentId    = stripeSession.payment_intent || null;
        pending.stripeConnectedAccountId = business.stripeAccountId;
        pending.platformFeeAmount        = applicationFeeAmount;
        pending.platformFeePercent       = Number((feeRate * 100).toFixed(4));
        pending.grossAmount              = totalInCents;
        pending.netToBusinessAmount      = totalInCents - applicationFeeAmount;
        await pending.save();

        return res.status(201).json({
            sessionUrl: stripeSession.url,
        });
    } catch (err) {
        console.error("[createCheckoutSession] Error:", err);
        return res.status(500).json({ message: "Server error creating checkout session" });
    }
}
