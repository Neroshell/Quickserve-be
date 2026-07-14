import { Resend } from "resend";
import dotenv from "dotenv";
import React from "react";
import { render } from "@react-email/render";
import ReceiptEmail from "../../emails/ReceiptEmail.js";
import AuthEmail from "../../emails/AuthEmail.js";
import OnboardingEmail from "../../emails/OnboardingEmail.js";
import ReservationRequestEmail from "../../emails/ReservationRequestEmail.js";
import ReservationRequestReceivedEmail from "../../emails/ReservationRequestReceivedEmail.js";
import ReservationConfirmedEmail from "../../emails/ReservationConfirmedEmail.js";
import ReservationCancelledEmail from "../../emails/ReservationCancelledEmail.js";
import EmailChangeEmail from "../../emails/EmailChangeEmail.js";
import Business from "../models/Business.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

function toCurrencyAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

export function getReceiptServiceFeeAmount(order) {
  const mode = order?.platformFeeMode;
  const customerPlatformFeeCents = Number(order?.customerPlatformFeeCents);
  const platformFeeTotal = toCurrencyAmount(order?.platformFeeTotal);
  const platformFeeCents = Number(order?.platformFeeCents);
  const modeAllowsCustomerFee =
    mode === "customer_pays" ||
    mode === "split" ||
    (!mode && (customerPlatformFeeCents > 0 || platformFeeTotal > 0));

  if (!modeAllowsCustomerFee) return 0;

  if (Number.isFinite(customerPlatformFeeCents) && customerPlatformFeeCents > 0) {
    return toCurrencyAmount(customerPlatformFeeCents / 100);
  }

  if (platformFeeTotal > 0) return platformFeeTotal;

  if (mode === "customer_pays" && Number.isFinite(platformFeeCents) && platformFeeCents > 0) {
    return toCurrencyAmount(platformFeeCents / 100);
  }

  return 0;
}

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
      subtotal: order.subtotal ?? order.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0),
      taxAmount: order.taxAmount || 0,
      serviceFeeAmount: getReceiptServiceFeeAmount(order),
      tipAmount: order.tipAmount || 0,
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

/**
 * Send a self-service onboarding email verification code.
 * @param {object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.userName - Display name of the signup owner
 * @param {string} params.verificationCode - Six-digit verification code
 * @param {string} params.verificationLink - Full URL that auto-verifies the code
 */
export async function sendOnboardingVerificationCode({ to, userName, verificationCode, verificationLink }) {
  try {
    const html = await render(React.createElement(OnboardingEmail, {
      userName,
      businessName: "QuickServe",
      inviteLink: verificationLink,
      verificationCode,
      role: "owner"
    }));
    const subject = "Verify your QuickServe email";
    const from = process.env.EMAIL_FROM_ONBOARDING || "QuickServe <onboarding@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService] Error in sendOnboardingVerificationCode:", error);
    return false;
  }
}

/**
 * Send a reservation request email to the business owner.
 */
export async function sendReservationRequestEmail({ to, businessName, reservation }) {
  try {
    const html = await render(React.createElement(ReservationRequestEmail, { businessName, reservation }));
    const subject = `New Reservation Request for ${businessName}`;
    const from = process.env.EMAIL_FROM_RESERVATIONS || "QuickServe Reservations <reservations@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService]  Error in sendReservationRequestEmail:", error);
    return false;
  }
}

const RESERVATION_FROM = process.env.EMAIL_FROM_RESERVATIONS || "QuickServe Reservations <reservations@quickservehq.com>";

/**
 * Customer-facing: confirm a reservation request was received (status: pending).
 * @param {object} params
 * @param {string} params.to - Customer email
 * @param {string} params.businessName
 * @param {string} [params.businessLogoUrl]
 * @param {string} [params.primaryColor]
 * @param {object} params.reservation - Plain reservation object
 */
export async function sendReservationRequestReceivedEmail({ to, businessName, businessLogoUrl, primaryColor, reservation }) {
  try {
    const html = await render(React.createElement(ReservationRequestReceivedEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = `Reservation Request Received - ${businessName}`;
    return await sendEmail({ to, subject, html, from: RESERVATION_FROM });
  } catch (error) {
    console.error("[EmailService]  Error in sendReservationRequestReceivedEmail:", error);
    return false;
  }
}

/**
 * Customer-facing: notify the customer their reservation is confirmed.
 */
export async function sendReservationConfirmedEmail({ to, businessName, businessLogoUrl, primaryColor, reservation }) {
  try {
    const html = await render(React.createElement(ReservationConfirmedEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = `Reservation Confirmed - ${businessName}`;
    return await sendEmail({ to, subject, html, from: RESERVATION_FROM });
  } catch (error) {
    console.error("[EmailService]  Error in sendReservationConfirmedEmail:", error);
    return false;
  }
}

/**
 * Customer-facing: notify the customer their reservation cannot be accommodated.
 */
export async function sendReservationCancelledEmail({ to, businessName, businessLogoUrl, primaryColor, reservation }) {
  try {
    const html = await render(React.createElement(ReservationCancelledEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = `Reservation Unavailable - ${businessName}`;
    return await sendEmail({ to, subject, html, from: RESERVATION_FROM });
  } catch (error) {
    console.error("[EmailService]  Error in sendReservationCancelledEmail:", error);
    return false;
  }
}
/**
 * Send email change verification link to the new email address.
 */
export async function sendEmailChangeVerification({ to, userName, confirmLink, oldEmail, newEmail }) {
  try {
    const html = await render(React.createElement(EmailChangeEmail, { mode: "verify", userName, confirmLink, oldEmail, newEmail }));
    const subject = "Confirm your new QuickServe login email";
    const from = process.env.EMAIL_FROM_AUTH || "QuickServe Auth <auth@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService] Error in sendEmailChangeVerification:", error);
    return false;
  }
}

/**
 * Send security notification to the old email after a successful email change.
 */
export async function sendEmailChangeNotification({ to, userName, oldEmail, newEmail }) {
  try {
    const html = await render(React.createElement(EmailChangeEmail, { mode: "notify", userName, oldEmail, newEmail }));
    const subject = "Your QuickServe login email has been changed";
    const from = process.env.EMAIL_FROM_AUTH || "QuickServe Auth <auth@quickservehq.com>";
    return await sendEmail({ to, subject, html, from });
  } catch (error) {
    console.error("[EmailService] Error in sendEmailChangeNotification:", error);
    return false;
  }
}
