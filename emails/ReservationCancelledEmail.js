import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent when a reservation cannot be accommodated (cancelled
 * / declined by the business).
 */
export default function ReservationCancelledEmail({ businessName, businessLogoUrl, primaryColor, reservation = {} }) {
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `Update on your reservation request at ${businessName}`,
    title: "Reservation Unavailable",
    customerName: reservation.customerName,
    intro: [
      "Thank you for your reservation request.",
      "Unfortunately, we are unable to accommodate this reservation.",
    ],
    detailsTitle: "Requested Details",
    // Per spec, the cancellation email omits the service point.
    details: [
      { label: "Date", value: formatReservationDate(reservation.date) },
      { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
      { label: "Guests", value: reservation.guestCount },
    ],
    closing: [
      "Please feel free to submit another reservation request for a different time or date.",
      "Thank you for your understanding,",
    ],
  });
}
