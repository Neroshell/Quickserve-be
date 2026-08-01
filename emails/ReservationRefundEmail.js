import React from "react";
import ReservationEmailBase, {
  formatReservationDate,
} from "./ReservationEmailBase.js";

function formatCents(amountCents, currency) {
  const normalizedCurrency = String(currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    return (Number(amountCents || 0) / 100).toFixed(2);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: normalizedCurrency,
  }).format(Number(amountCents || 0) / 100);
}

export default function ReservationRefundEmail({
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation = {},
  refund = {},
}) {
  const originalPaidCents = Number(refund.originalPaidAmountCents || 0);
  const refundedCents = Number(reservation.refundedAmountCents || 0);
  const retainedCents = Math.max(0, originalPaidCents - refundedCents);

  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `Your refund from ${businessName} has been issued`,
    title: "Refund Confirmed",
    customerName: reservation.customerName,
    intro: [
      "Your reservation has been cancelled and the refund below has been issued to your original payment method.",
      "Most card refunds appear within 5–10 business days. In some cases, the original charge may disappear or update instead of showing as a separate refund.",
    ],
    detailsTitle: "Refund Details",
    details: [
      {
        label: "Reservation",
        value:
          reservation.publicReference ||
          String(reservation._id || ""),
      },
      {
        label: "Check-in",
        value: formatReservationDate(reservation.checkInDate),
      },
      {
        label: "Check-out",
        value: formatReservationDate(reservation.checkOutDate),
      },
      {
        label: "Refund issued",
        value: formatCents(
          refund.successfulAmountCents || refund.requestedAmountCents,
          refund.currency || reservation.currency,
        ),
      },
      {
        label: "Total refunded",
        value: formatCents(
          refundedCents,
          refund.currency || reservation.currency,
        ),
      },
      {
        label: "Payment retained",
        value: formatCents(
          retainedCents,
          refund.currency || reservation.currency,
        ),
      },
    ],
    closing: [
      "If the refund is not visible after 10 business days, please contact your bank and reference the original card payment.",
      "Thank you,",
    ],
  });
}
