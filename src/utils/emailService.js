import { Resend } from "resend";
import dotenv from "dotenv";
import React from "react";
import { render } from "@react-email/render";
import ReceiptEmail from "../../emails/ReceiptEmail.js";
import AuthEmail from "../../emails/AuthEmail.js";
import OnboardingEmail from "../../emails/OnboardingEmail.js";
import Business from "../models/Business.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail({ to, subject, html, from }) {
  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html,
    });

    if (error) {
      console.error("[EmailService]  Error sending email:", error);
      return false;
    }

    console.log(`[EmailService]  Email sent to ${to} (Message ID: ${data?.id})`);
    return true;
  } catch (error) {
    console.error("[EmailService]  Transport/Execution Error sending email:", error);
    return false;
  }
}

export async function sendReceiptEmail(order, toEmail) {
  try {
    console.log(`[EmailService] Initiating sendReceiptEmail for order: ${order.orderId}, email: ${toEmail}`);
    
    if (!order.items || !Array.isArray(order.items)) {
       console.error(`[EmailService]  order.items is invalid:`, order.items);
       return false;
    }

    // Fetch business details
    const business = await Business.findOne({
      $or: [{ businessId: order.businessId }, { restaurantId: order.businessId }]
    }).lean();

    const businessName = business?.displayName || business?.name || "QuickServe";
    const businessLogoUrl = business?.logoUrl;
    const servicePointTerm = business?.businessType === "hotel_apartment" ? "Room" : "Table";

    const props = {
      businessName,
      businessLogoUrl,
      orderId: order.orderId,
      orderDate: new Date(order.createdAt).toLocaleString(),
      servicePointLabel: order.tableLabel,
      servicePointCode: order.tableNumber,
      servicePointTerm,
      orderType: order.orderType,
      paymentMethod: order.paidVia || order.paymentChannel,
      paymentStatus: order.paymentStatus,
      currency: order.currency || "USD",
      items: order.items.map(item => ({
        itemName: item.itemName,
        quantity: item.quantity,
        lineTotal: item.lineTotal || 0,
        notes: item.notes,
        allergies: item.allergies
      })),
      subtotal: order.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0),
      taxAmount: 0, // Not explicitly stored on order root currently, would be calculated or passed
      total: order.total || 0
    };

    const html = await render(React.createElement(ReceiptEmail, props));

    const subject = `Your receipt from ${businessName} — ${order.orderId}`;
    const from = process.env.EMAIL_FROM_RECEIPTS || "QuickServe Receipts <receipts@quickservehq.com>";
    
    return await sendEmail({ to: toEmail, subject, html, from });
  } catch (error) {
    console.error("[EmailService]  Error in sendReceiptEmail:", error);
    return false;
  }
}

/**
 * Send a password reset email.
 * @param {object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.userName - Display name of the user
 * @param {string} params.resetLink - Full password reset URL
 */
export async function sendAuthEmail({ to, userName, resetLink }) {
  try {
    const html = await render(React.createElement(AuthEmail, { userName, resetLink }));
    const subject = `Reset Your QuickServe Password`;
    const from = process.env.EMAIL_FROM_AUTH || "QuickServe Auth <auth@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService]  Error in sendAuthEmail:", error);
    return false;
  }
}

/**
 * Send an onboarding / invitation email.
 * @param {object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.userName - Display name of the invitee
 * @param {string} [params.businessName] - Business name (for owner invites)
 * @param {string} params.inviteLink - Full account setup URL
 * @param {'owner'|'staff'} params.role - Role of the invitee
 */
export async function sendOnboardingEmail({ to, userName, businessName, inviteLink, role = "staff" }) {
  try {
    const html = await render(React.createElement(OnboardingEmail, { userName, businessName, inviteLink, role }));
    const subject = role === "owner"
      ? `Welcome to QuickServe — Set up your account for ${businessName}`
      : `You've been added as Staff on QuickServe`;
    const from = process.env.EMAIL_FROM_ONBOARDING || "QuickServe <onboarding@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService]  Error in sendOnboardingEmail:", error);
    return false;
  }
}
