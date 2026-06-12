import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent immediately after a reservation request is submitted.
 * Confirms receipt and sets the expectation that the request is pending review.
 */
export default function ReservationRequestReceivedEmail({ businessName, businessLogoUrl, primaryColor, reservation = {} }) {
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `We've received your reservation request at ${businessName}`,
    title: "Reservation Request Received",
    customerName: reservation.customerName,
    intro: [
      `Thank you for your reservation request at ${businessName}.`,
      "Your reservation is currently pending review. We will notify you once it has been confirmed or declined.",
    ],
    detailsTitle: "Reservation Details",
    details: [
      { label: "Date", value: formatReservationDate(reservation.date) },
      { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
      { label: "Guests", value: reservation.guestCount },
      { label: "Service Point", value: reservation.servicePointLabel },
    ],
    closing: [
      "We'll be in touch shortly. Thank you,",
    ],
  });
}
