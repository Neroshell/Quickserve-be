import React from "react";
import ReservationEmailBase, { formatReservationDate } from "./ReservationEmailBase.js";

/**
 * Customer-facing email sent when a reservation is accepted but requires payment.
 */
export default function ReservationPaymentEmail({ businessName, businessLogoUrl, primaryColor, reservation = {}, paymentUrl }) {
  const isHotel = Boolean(reservation.checkInDate && reservation.checkOutDate);

  const formatCurrency = (amount, currency = "USD") => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency,
    }).format(amount || 0);
  };

  const totalStr = reservation.totalPrice != null 
    ? formatCurrency(reservation.totalPrice, reservation.currency) 
    : (reservation.totalAmount != null ? formatCurrency(reservation.totalAmount, reservation.currency) : null);

  const details = isHotel ? [
    { label: "Dates", value: `${formatReservationDate(reservation.checkInDate)} to ${formatReservationDate(reservation.checkOutDate)}` },
    { label: "Guests", value: reservation.guestCount },
    { label: "Room", value: reservation.servicePointLabel },
  ] : [
    { label: "Date", value: formatReservationDate(reservation.date) },
    { label: "Time", value: reservation.startTime && reservation.endTime ? `${reservation.startTime} - ${reservation.endTime}` : "" },
    { label: "Guests", value: reservation.guestCount },
    { label: "Service Point", value: reservation.servicePointLabel },
  ];

  if (totalStr) {
    details.push({ label: "Total Due", value: totalStr });
  }
  details.push({ label: "Status", value: "Awaiting Payment" });

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
    details,
    callToAction: paymentUrl ? { text: "Pay Now", url: paymentUrl } : null,
    closing: [
      "We look forward to welcoming you. Thank you,",
    ],
  });
}
