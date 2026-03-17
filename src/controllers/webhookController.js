import Stripe from "stripe";
import PendingCheckout from "../models/PendingCheckout.js";
import Order from "../models/order.js";
import { generateOrderId } from "../utils/orderId.js";
import { toOrderDTO } from "../utils/orderDTO.js";
import { broadcast, broadcastToRole } from "../utils/sseManager.js";
import { sendReceiptEmail } from "../utils/emailService.js";

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
        if (event.type !== "checkout.session.completed") {
            console.log(`[stripeWebhook] Ignoring event type: ${event.type}`);
            return res.status(200).send();
        }

        const session = event.data.object;
        console.log("[stripeWebhook] Session ID:", session.id);
        console.log("[stripeWebhook] Metadata:", JSON.stringify(session.metadata || {}));

        const { pendingCheckoutId } = session.metadata || {};

        if (!pendingCheckoutId) {
            console.error("[stripeWebhook] No pendingCheckoutId in metadata");
            return res.status(200).send();
        }

        const pending = await PendingCheckout.findById(pendingCheckoutId);

        if (!pending) {
            console.error(`[stripeWebhook] PendingCheckout not found: ${pendingCheckoutId}`);
            return res.status(200).send();
        }

        if (!pending.restaurantId) {
            console.error(`[stripeWebhook] PendingCheckout missing restaurantId: ${pendingCheckoutId}`);
            return res.status(200).send();
        }

        console.log(
            `[stripeWebhook] PendingCheckout found — restaurantId=${pending.restaurantId}, table=${pending.tableNumber}, items=${pending.items.length}`
        );

        const restaurantId = pending.restaurantId;
        const orderId = pending.orderId || generateOrderId(pending.tableNumber);

        // Idempotency guard:
        // if Stripe retries the webhook, do not create duplicate orders
        let order = await Order.findOne({ restaurantId, orderId });

        if (order) {
            console.log(
                `[stripeWebhook] Order already exists for restaurantId=${restaurantId}, orderId=${orderId}`
            );

            // Retry receipt email if it wasn't sent yet
            const customerEmail = pending.receiptEmail || session.customer_details?.email || null;
            if (customerEmail && !order.receiptSent) {
                console.log(`[stripeWebhook] Retrying receipt email to ${customerEmail} (idempotency fallback)`);
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    if (emailSent) {
                        await Order.findOneAndUpdate(
                            { restaurantId, orderId },
                            { receiptSent: true }
                        );
                        console.log(`[stripeWebhook] Receipt sent to ${customerEmail}`);
                    }
                } catch (err) {
                    console.error("[stripeWebhook] Error sending receipt (fallback):", err);
                }
            }
        } else {
            const hasFood = pending.items.some(
                (i) => i.category === "food" || i.type === "food"
            );
            const initialStatus = hasFood ? "placed" : "ready";
            
            console.log(`[stripeWebhook] Resolving customerEmail...`);
            console.log(`[stripeWebhook] pending.receiptEmail:`, pending.receiptEmail);
            console.log(`[stripeWebhook] session.customer_details?.email:`, session.customer_details?.email);
            console.log(`[stripeWebhook] session.customer_email:`, session.customer_email);
            
            const customerEmail =
                pending.receiptEmail || session.customer_details?.email || null;
            
            console.log(`[stripeWebhook] Final customerEmail resolved to:`, customerEmail);

            order = await Order.create({
                restaurantId,
                orderId,
                tableNumber: pending.tableNumber,
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
                receiptEmail: customerEmail,
                receiptSent: false,
            });

            console.log(
                `[stripeWebhook] Order created: ${orderId} for restaurantId=${restaurantId}`
            );
            console.log(`[stripeWebhook] Created order receiptEmail: ${order.receiptEmail}, receiptSent: ${order.receiptSent}`);

            if (customerEmail) {
                console.log(`[stripeWebhook] Calling sendReceiptEmail for ${customerEmail} on order ${order.orderId}`);
                try {
                    const emailSent = await sendReceiptEmail(order, customerEmail);
                    console.log(`[stripeWebhook] sendReceiptEmail resolved with: ${emailSent}`);
                    if (emailSent) {
                        await Order.findOneAndUpdate(
                            { restaurantId, orderId },
                            { receiptSent: true }
                        );
                        console.log(`[stripeWebhook] Document updated: receiptSent set to true for ${order.orderId}`);
                    } else {
                        console.error(`[stripeWebhook] sendReceiptEmail returned false for ${order.orderId}. Not updating receiptSent.`);
                    }
                } catch (err) {
                    console.error("[stripeWebhook] Error in sendReceiptEmail execution block:", err);
                }
            } else {
                console.log(`[stripeWebhook] Skipping sendReceiptEmail because customerEmail is falsy`);
            }

            const orderDTO = toOrderDTO(order);

            const foodItems = order.items.filter(
                (i) => i.category === "food" || i.type === "food"
            );

            if (foodItems.length > 0) {
                const kitchenDTO = { ...orderDTO, items: foodItems };
                broadcastToRole("kitchen", "order_created", { order: kitchenDTO });
                console.log(
                    `[stripeWebhook] Broadcast to kitchen for restaurantId=${restaurantId}`
                );
            }

            // Send full order to waiter + table clients (not kitchen)
            broadcast("order_created", { order: orderDTO }, (client) => client.role !== "kitchen");
            console.log(
                `[stripeWebhook] Broadcast to waiter for restaurantId=${restaurantId}`
            );
        }

        await PendingCheckout.findByIdAndDelete(pendingCheckoutId);
        console.log(`[stripeWebhook] Cleaned up PendingCheckout: ${pendingCheckoutId}`);

        return res.status(200).send();
    } catch (error) {
        console.error("[stripeWebhook] Error processing webhook:", error);
        return res.status(500).send("Internal Server Error");
    }
}