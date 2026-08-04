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
import ReservationPaymentEmail from "../../emails/ReservationPaymentEmail.js";
import ReservationCancelledEmail from "../../emails/ReservationCancelledEmail.js";
import ReservationRefundEmail from "../../emails/ReservationRefundEmail.js";
import EmailChangeEmail from "../../emails/EmailChangeEmail.js";
import HotelPaymentConfirmationEmail from "../../emails/HotelPaymentConfirmationEmail.js";
import Business from "../models/Business.js";
import ServicePoint from "../models/ServicePoint.js";
import { getCustomerReservationPricing } from "../services/reservationPricingService.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
export const EMAIL_PROVIDER_TIMEOUT_MS = 30_000;

export class EmailDeliveryError extends Error {
  constructor(message, {
    code = "email_delivery_failed",
    retryable = true,
    statusCode = null,
  } = {}) {
    super(message);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function toCurrencyAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function maskEmailAddress(value) {
  const email = String(value || "").trim();
  const atIndex = email.indexOf("@");
  if (atIndex <= 1) return email ? "***" : "";
  return `${email.slice(0, 2)}***${email.slice(atIndex)}`;
}

export function getOrderReceiptIdempotencyKey(order) {
  const businessId = String(order?.businessId || "unknown-business");
  const orderId = String(order?.orderId || order?._id || "unknown-order");
  return `order-receipt/${businessId}/${orderId}`.slice(0, 256);
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

function isInternalServicePointId(value) {
  return /^sp_[a-z0-9]+$/i.test(String(value || "").trim());
}

export async function getReceiptServicePointLabel(order) {
  const cachedDisplayLabel = String(order?.displayLabel || "").trim();
  if (cachedDisplayLabel && !isInternalServicePointId(cachedDisplayLabel)) {
    return cachedDisplayLabel;
  }

  const storedServicePointValue = String(order?.servicePointLabel || "").trim();
  if (!isInternalServicePointId(storedServicePointValue)) {
    return storedServicePointValue || "Service Point";
  }

  const servicePoint = await ServicePoint.findOne({
    businessId: order?.businessId,
    servicePointId: storedServicePointValue,
  }).lean();

  return String(servicePoint?.label || servicePoint?.code || "Service Point").trim();
}

function providerStatusCode(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(statusCode) ? statusCode : null;
}

export function isPermanentEmailProviderError(error) {
  const statusCode = providerStatusCode(error);
  if ([400, 401, 403, 404, 422].includes(statusCode)) return true;

  const name = String(error?.name || error?.code || "").toLowerCase();
  return (
    name.includes("validation") ||
    name.includes("invalid_recipient") ||
    name.includes("invalid_parameter") ||
    name.includes("missing_required_field")
  );
}

function normalizeEmailDeliveryError(error) {
  if (error instanceof EmailDeliveryError) return error;

  const statusCode = providerStatusCode(error);
  const retryable = !isPermanentEmailProviderError(error);
  const providerCode = String(error?.name || error?.code || "provider_error")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);

  return new EmailDeliveryError(
    retryable
      ? "The email provider is temporarily unavailable."
      : "The email provider permanently rejected the message.",
    {
      code: providerCode || "provider_error",
      retryable,
      statusCode,
    },
  );
}

function withProviderTimeout(promise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new EmailDeliveryError(
        "The email provider request timed out.",
        { code: "provider_timeout", retryable: true },
      ));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

export async function sendEmailWithResult({
  to,
  subject,
  html,
  from,
  idempotencyKey,
  emailClient = resend,
  timeoutMs = EMAIL_PROVIDER_TIMEOUT_MS,
}) {
  const message = { from, to, subject, html };
  const requestOptions = idempotencyKey ? { idempotencyKey } : undefined;

  try {
    const { data, error } = await withProviderTimeout(
      emailClient.emails.send(message, requestOptions),
      timeoutMs,
    );

    if (error) {
      throw normalizeEmailDeliveryError(error);
    }

    console.log("[EmailService] Provider accepted email", {
      provider: "resend",
      providerStatus: "accepted",
      recipient: maskEmailAddress(to),
      providerMessageId: data?.id || null,
    });
    return {
      success: true,
      messageId: data?.id || null,
    };
  } catch (error) {
    throw normalizeEmailDeliveryError(error);
  }
}

// Compatibility wrapper retained for existing synchronous callers. Queued
// handlers use sendEmailWithResult so BullMQ can distinguish retryable failures.
export async function sendEmail(options) {
  try {
    await sendEmailWithResult(options);
    return true;
  } catch (error) {
    console.error("[EmailService] Email delivery failed", {
      provider: "resend",
      recipient: maskEmailAddress(options?.to),
      name: error.name,
      code: error.code || "email_delivery_failed",
      retryable: error.retryable !== false,
      responseCode: error.statusCode || null,
    });
    return false;
  }
}

async function deliverPreparedEmail(options, { returnResult = false, timeoutMs } = {}) {
  if (returnResult) {
    return sendEmailWithResult({ ...options, timeoutMs });
  }
  return sendEmail({ ...options, timeoutMs });
}

export async function sendReceiptEmail(
  order,
  toEmail,
  { idempotencyKey, returnResult = false, timeoutMs } = {},
) {
  try {
    console.log("[EmailService] Initiating order receipt", {
      orderId: order.orderId,
      businessId: order.businessId,
      recipient: maskEmailAddress(toEmail),
    });
    
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
    const servicePointLabel = await getReceiptServicePointLabel(order);

    const props = {
      businessName,
      businessLogoUrl,
      orderId: order.orderId,
      orderDate: new Date(order.createdAt).toLocaleString(),
      servicePointLabel,
      servicePointCode: servicePointLabel,
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
    
    return await deliverPreparedEmail(
      { to: toEmail, subject, html, from, idempotencyKey },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
    console.error("[EmailService] Error in sendReceiptEmail", {
      orderId: order?.orderId,
      businessId: order?.businessId,
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
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
 */
export async function sendOnboardingVerificationCode({ to, userName, verificationCode }) {
  try {
    const html = await render(React.createElement(OnboardingEmail, {
      userName,
      businessName: "QuickServe",
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
export async function sendReservationRequestEmail({
  to,
  businessName,
  reservation,
  idempotencyKey,
  returnResult = false,
  timeoutMs,
}) {
  try {
    const html = await render(React.createElement(ReservationRequestEmail, { businessName, reservation }));
    const subject = `New Reservation Request for ${businessName}`;
    const from = process.env.EMAIL_FROM_RESERVATIONS || "QuickServe Reservations <reservations@quickservehq.com>";
    return await deliverPreparedEmail(
      { to, subject, html, from, idempotencyKey },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
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
export async function sendReservationRequestReceivedEmail({
  to,
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation,
  idempotencyKey,
  returnResult = false,
  timeoutMs,
}) {
  try {
    const html = await render(React.createElement(ReservationRequestReceivedEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = `Reservation Request Received - ${businessName}`;
    return await deliverPreparedEmail(
      { to, subject, html, from: RESERVATION_FROM, idempotencyKey },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
    console.error("[EmailService]  Error in sendReservationRequestReceivedEmail:", error);
    return false;
  }
}

/**
 * Customer-facing: notify the customer their reservation is confirmed.
 */
export async function sendReservationConfirmedEmail({
  to,
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation,
  idempotencyKey,
  returnResult = false,
  timeoutMs,
}) {
  try {
    const html = await render(React.createElement(ReservationConfirmedEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = `Reservation Confirmed - ${businessName}`;
    return await deliverPreparedEmail(
      { to, subject, html, from: RESERVATION_FROM, idempotencyKey },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
    console.error("[EmailService]  Error in sendReservationConfirmedEmail:", error);
    return false;
  }
}

/**
 * Customer-facing: notify the customer their reservation is accepted but requires payment.
 */
export async function sendReservationPaymentEmail({ to, businessName, businessLogoUrl, primaryColor, reservation }) {
  try {
    if (!reservation.secureToken) {
      console.error("[sendReservationPaymentEmail] reservation.secureToken is missing — cannot build payment URL", {
        reservationId: reservation._id,
      });
      return false;
    }
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || "https://quickservehq.com";
    // Points to the QuickServe payment page, NOT the post-payment confirmation page.
    const paymentUrl = `${frontendBaseUrl}/reservation/pay/${reservation.secureToken}`;
    const html = await render(React.createElement(ReservationPaymentEmail, { businessName, businessLogoUrl, primaryColor, reservation, paymentUrl }));
    const subject = `Action Required: Payment for your Reservation - ${businessName}`;
    return await sendEmail({ to, subject, html, from: RESERVATION_FROM });
  } catch (error) {
    console.error("[sendReservationPaymentEmail] Error", {
      name: error.name,
      message: error.message,
      reservationId: reservation?._id,
      stack: error.stack,
    });
    return false;
  }
}

/**
 * Customer-facing: notify the customer their reservation cannot be accommodated.
 */
export async function sendReservationCancelledEmail({
  to,
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation,
  idempotencyKey,
  returnResult = false,
  timeoutMs,
}) {
  try {
    const html = await render(React.createElement(ReservationCancelledEmail, { businessName, businessLogoUrl, primaryColor, reservation }));
    const subject = reservation?.cancellationOutcome
      ? `Reservation Cancelled - ${businessName}`
      : `Reservation Unavailable - ${businessName}`;
    return await deliverPreparedEmail(
      { to, subject, html, from: RESERVATION_FROM, idempotencyKey },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
    console.error("[EmailService]  Error in sendReservationCancelledEmail:", error);
    return false;
  }
}

export function getReservationRefundEmailIdempotencyKey(refund) {
  return `reservation-refund/${refund?.businessId || "unknown-business"}/${refund?.refundId || "unknown-refund"}`.slice(0, 256);
}

/**
 * Customer-facing confirmation sent only after Stripe reports a successful
 * reservation refund. Card issuers commonly take 5-10 business days to post it.
 */
export async function sendReservationRefundEmail({
  to,
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation,
  refund,
  returnResult = false,
  timeoutMs,
}) {
  try {
    const html = await render(
      React.createElement(ReservationRefundEmail, {
        businessName,
        businessLogoUrl,
        primaryColor,
        reservation,
        refund,
      }),
    );
    return await deliverPreparedEmail(
      {
        to,
        subject: `Refund Confirmed - ${businessName}`,
        html,
        from: RESERVATION_FROM,
        idempotencyKey: getReservationRefundEmailIdempotencyKey(refund),
      },
      { returnResult, timeoutMs },
    );
  } catch (error) {
    if (returnResult) throw error;
    console.error("[EmailService] Error in sendReservationRefundEmail:", {
      name: error?.name,
      message: error?.message,
      refundId: refund?.refundId,
    });
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

/**
 * Send hotel check-in / payment confirmation email
 */
export async function sendHotelPaymentConfirmationEmail({ reservation, business, plainCheckInCode, validFrom, expiresAt }) {
  try {
    const formatCurrency = (amount, currency) => {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD",
      }).format(amount || 0);
    };

    const businessName = business?.displayName || business?.name || "QuickServe Hotel";
    const primaryColor = business?.branding?.primaryColor || "#ea580c";
    
    const formatDate = (date) => date ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    
    const pricing = getCustomerReservationPricing(reservation);

    const html = await render(React.createElement(HotelPaymentConfirmationEmail, {
      businessName,
      businessLogoUrl: business?.logoUrl,
      primaryColor,
      customerName: reservation.name,
      publicReference: reservation.publicReference || reservation._id.toString(),
      servicePointLabel: reservation.servicePointLabel || "Room",
      checkInDate: formatDate(reservation.checkInDate || reservation.date),
      checkOutDate: formatDate(reservation.checkOutDate || reservation.date),
      guestCount: reservation.guestCount || 1,
      accommodationLabel: "Accommodation",
      formattedSubtotal: formatCurrency(pricing.subtotal, reservation.currency),
      taxLabel: "Tax",
      formattedTaxAmount: formatCurrency(pricing.taxAmount, reservation.currency),
      platformFeeLabel: pricing.platformFeeLabel || "Platform Fee",
      formattedPlatformFeeAmount: formatCurrency(pricing.customerPlatformFeeAmount, reservation.currency),
      formattedAmount: formatCurrency(pricing.total, reservation.currency),
      checkInCode: plainCheckInCode,
      validFrom: validFrom ? new Date(validFrom).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }) : "",
      expiresAt: expiresAt ? new Date(expiresAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }) : "",
    }));

    const subject = `Your booking at ${businessName} is confirmed`;
    const from = process.env.EMAIL_FROM_RESERVATIONS || "QuickServe Reservations <reservations@quickservehq.com>";
    
    return await sendEmail({ to: reservation.email, subject, html, from });
  } catch (error) {
    console.error("[EmailService] Error in sendHotelPaymentConfirmationEmail:", error);
    return false;
  }
}
