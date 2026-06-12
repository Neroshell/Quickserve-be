import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent when a reservation is confirmed by the business.
 */
export default function ReservationConfirmedEmail({ businessName, businessLogoUrl, primaryColor, reservation = {} }) {
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `Your reservation at ${businessName} is confirmed`,
    title: "Reservation Confirmed",
    customerName: reservation.customerName,
    intro: [
      "Great news!",
      `Your reservation at ${businessName} has been confirmed.`,
    ],
    detailsTitle: "Reservation Details",
    details: [
      { label: "Date", value: formatReservationDate(reservation.date) },
      { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
      { label: "Guests", value: reservation.guestCount },
      { label: "Service Point", value: reservation.servicePointLabel },
    ],
    closing: [
      "We look forward to welcoming you. Thank you,",
    ],
  });
}
