import React from "react";
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Heading,
  Hr,
  Img,
} from "@react-email/components";

export default function ReservationRequestEmail({ businessName, reservation }) {
  const e = React.createElement;
  const previewText = `New Reservation Request for ${businessName}`;

  return e(Html, null,
    e(Head, null),
    e(Preview, null, previewText),
    e(Body, { style: main },
      e(Container, { style: container },
        e(Heading, { style: h1 }, "New Reservation Request"),
        e(Text, { style: text },
          "You have received a new reservation request for ",
          e("strong", null, businessName),
          "."
        ),
        e(Section, { style: detailsSection },
          e(Text, { style: detailText }, e("strong", null, "Customer Name:"), " ", reservation.customerName),
          e(Text, { style: detailText }, e("strong", null, "Phone:"), " ", reservation.phone),
          reservation.email ? e(Text, { style: detailText }, e("strong", null, "Email:"), " ", reservation.email) : null,
          e(Text, { style: detailText }, e("strong", null, "Date:"), " ", reservation.date),
          e(Text, { style: detailText }, e("strong", null, "Time:"), " ", reservation.time),
          e(Text, { style: detailText }, e("strong", null, "Guests:"), " ", reservation.guestCount),
          (reservation.seatingPreference && reservation.seatingPreference !== "no_preference") 
            ? e(Text, { style: detailText }, e("strong", null, "Seating Preference:"), " ", reservation.seatingPreference)
            : null,
          reservation.specialRequest 
            ? e(Text, { style: detailText }, e("strong", null, "Special Request:"), " ", reservation.specialRequest)
            : null
        ),
        e(Hr, { style: hr }),
        e(Text, { style: footer },
          "Log into your QuickServe owner dashboard to confirm or cancel this reservation."
        )
      )
    )
  );
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "20px 0 48px",
  marginBottom: "64px",
  border: "1px solid #e6ebf1",
  borderRadius: "5px",
  maxWidth: "600px",
};

const h1 = {
  color: "#333",
  fontSize: "24px",
  fontWeight: "bold",
  textAlign: "center",
  padding: "0 20px",
  margin: "30px 0",
};

const text = {
  color: "#525f7f",
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "center",
  padding: "0 20px",
  marginBottom: "20px",
};

const detailsSection = {
  padding: "20px",
  backgroundColor: "#f8f9fa",
  borderRadius: "5px",
  margin: "0 20px",
};

const detailText = {
  color: "#333",
  fontSize: "15px",
  lineHeight: "24px",
  margin: "5px 0",
};

const hr = {
  borderColor: "#e6ebf1",
  margin: "20px 0",
};

const footer = {
  color: "#8898aa",
  fontSize: "14px",
  textAlign: "center",
  padding: "0 20px",
};
