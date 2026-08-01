import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent when a reservation cannot be accommodated (cancelled
 * / declined by the business).
 */
export default function ReservationCancelledEmail({ businessName, businessLogoUrl, primaryColor, reservation = {} }) {
  const isOwnerCancellation = Boolean(reservation.cancellationOutcome);
  const isNoRefund = reservation.cancellationOutcome === "no_refund";
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: isOwnerCancellation
      ? `Your reservation at ${businessName} has been cancelled`
      : `Update on your reservation request at ${businessName}`,
    title: isOwnerCancellation
      ? "Reservation Cancelled"
      : "Reservation Unavailable",
    customerName: reservation.customerName,
    intro: isOwnerCancellation
      ? [
          "Your reservation has been cancelled.",
          ...(isNoRefund
            ? ["No refund was issued for this cancellation."]
            : []),
        ]
      : [
          "Thank you for your reservation request.",
          "Unfortunately, we are unable to accommodate this reservation.",
        ],
    detailsTitle: isOwnerCancellation
      ? "Cancellation Details"
      : "Requested Details",
    // Per spec, the cancellation email omits the service point.
    details: [
      {
        label: "Check-in",
        value: formatReservationDate(
          reservation.checkInDate || reservation.date,
        ),
      },
      {
        label: "Check-out",
        value: formatReservationDate(reservation.checkOutDate),
      },
      { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
      { label: "Guests", value: reservation.guestCount },
      { label: "Reason", value: reservation.cancellationReason },
    ],
    closing: isOwnerCancellation
      ? ["If you have questions, please contact the property directly.", "Thank you,"]
      : [
          "Please feel free to submit another reservation request for a different time or date.",
          "Thank you for your understanding,",
        ],
  });
}
