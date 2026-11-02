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
  const previewText = `A new table request is awaiting review for ${businessName}.`;

  return e(Html, null,
    e(Head, null),
    e(Preview, null, previewText),
    e(Body, { style: main },
      e(Container, { style: container },
        e(Section, { style: header },
          e(Text, { style: brand }, "Chillow"),
          e(Heading, { style: h1 }, "New reservation request")
        ),
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
          "Open your Chillow owner dashboard to review this request. The guest has not been confirmed yet."
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
  padding: "0 0 32px",
  marginBottom: "64px",
  border: "1px solid #e6ebf1",
  borderRadius: "5px",
  maxWidth: "600px",
};

const h1 = {
  color: "#0f172a",
  fontSize: "26px",
  fontWeight: "bold",
  textAlign: "center",
  margin: "0",
};

const header = {
  borderTop: "4px solid #ea601a",
  padding: "20px",
  textAlign: "center",
};

const brand = {
  color: "#64748b",
  fontSize: "12px",
  fontWeight: "700",
  letterSpacing: "1px",
  textTransform: "uppercase",
  margin: "0 0 8px",
};

const text = {
  color: "#334155",
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left",
  padding: "0 20px",
  marginBottom: "20px",
};

const detailsSection = {
  padding: "20px",
  backgroundColor: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
  margin: "0 20px",
};

const detailText = {
  color: "#334155",
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
