import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

export default function ReservationArrivalReminderEmail({
  businessName,
  businessLogoUrl,
  primaryColor,
  reservation = {},
  arrivalUrl,
  notComingUrl,
  viewReservationUrl,
}) {
  return React.createElement(ReservationEmailBase, {
    businessName,
    businessLogoUrl,
    primaryColor,
    previewText: `Your reservation at ${businessName} is coming up`,
    title: "Your Reservation Is Coming Up",
    customerName: reservation.customerName,
    intro: [
      `This is a friendly reminder about your upcoming reservation at ${businessName}.`,
      "When you arrive, use the button below to let us know you're here.",
    ],
    detailsTitle: "Reservation Details",
    details: [
      { label: "Date", value: formatReservationDate(reservation.date) },
      {
        label: "Time",
        value: reservation.startTime && reservation.endTime
          ? `${reservation.startTime} - ${reservation.endTime}`
          : "",
      },
      { label: "Guests", value: reservation.guestCount },
      { label: "Service Point", value: reservation.servicePointLabel },
      { label: "Notes", value: reservation.specialRequest },
    ],
    callToAction: { text: "I'm Here", url: arrivalUrl },
    cancelAction: notComingUrl
      ? {
          label: "Can't make it?",
          copy: "If your plans have changed, kindly let the restaurant know.",
          text: "I Won't Be Coming",
          url: notComingUrl,
        }
      : null,
    closing: ["However, we look forward to welcoming you."],
  });
}
