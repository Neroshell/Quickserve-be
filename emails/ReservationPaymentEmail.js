import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent when a reservation is accepted but requires payment.
 */
export default function ReservationPaymentEmail({ businessName, businessLogoUrl, primaryColor, reservation = {} }) {
  // A link for them to complete payment should be provided if they need to pay, 
  // but if we don't have the exact checkout URL here, we will instruct them to check their status page.
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `Payment required for your reservation at ${businessName}`,
    title: "Action Required: Payment",
    customerName: reservation.customerName,
    intro: [
      `Your reservation at ${businessName} has been accepted!`,
      "However, to fully confirm your booking, a payment is required.",
      "Please complete your payment to secure your reservation.",
    ],
    detailsTitle: "Reservation Details",
    details: [
      { label: "Date", value: formatReservationDate(reservation.date) },
      { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
      { label: "Guests", value: reservation.guestCount },
      { label: "Service Point", value: reservation.servicePointLabel },
      { label: "Status", value: "Awaiting Payment" },
    ],
    closing: [
      "We look forward to welcoming you. Thank you,",
    ],
  });
}
