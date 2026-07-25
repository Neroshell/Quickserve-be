import React from "react";
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Row,
  Column,
  Text,
  Heading,
  Img,
  Hr,
} from "@react-email/components";

// Styles
const main = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "0",
  marginBottom: "64px",
  marginTop: "64px",
  borderRadius: "8px",
  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  maxWidth: "600px",
  overflow: "hidden",
};

const contentPadding = {
  padding: "32px 40px",
};

const codeBox = {
  backgroundColor: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "24px",
  textAlign: "center",
  margin: "32px 0",
};

export default function HotelPaymentConfirmationEmail({
  businessName = "Hotel Name",
  businessLogoUrl,
  primaryColor = "#ea580c",
  customerName = "Guest",
  publicReference = "QS-H-123456",
  servicePointLabel = "Deluxe Room",
  checkInDate = "2023-12-01",
  checkOutDate = "2023-12-03",
  guestCount = 2,
  accommodationLabel = "Accommodation",
  formattedSubtotal = "€120.00",
  taxLabel = "Tax",
  formattedTaxAmount,
  platformFeeLabel = "Platform Fee",
  formattedPlatformFeeAmount,
  formattedAmount = "€120.00",
  checkInCode = "123456",
  validFrom = "Dec 1 at 3:00 PM",
  expiresAt = "Dec 3 at 11:00 AM",
}) {
  const e = React.createElement;

  const header = {
    backgroundColor: primaryColor,
    padding: "32px 20px",
    textAlign: "center",
  };

  const codeStyle = {
    color: primaryColor,
    fontSize: "36px",
    fontWeight: "800",
    letterSpacing: "8px",
    margin: "8px 0",
    fontFamily: "monospace",
  };

  return e(Html, null,
    e(Head, null),
    e(Preview, null, `Your booking at ${businessName} is confirmed`),
    e(Body, { style: main },
      e(Container, { style: container },
        // Header
        e(Section, { style: header },
          businessLogoUrl ? e(Img, {
            src: businessLogoUrl,
            width: "64",
            height: "64",
            alt: businessName,
            style: {
              margin: "0 auto",
              borderRadius: "12px",
              marginBottom: "16px",
              objectFit: "cover",
              backgroundColor: "#fff",
            }
          }) : null,
          e(Heading, { style: { color: "#ffffff", margin: 0, fontSize: "24px" } }, "Booking Confirmed")
        ),
        
        // Body
        e(Section, { style: contentPadding },
          e(Text, { style: { fontSize: "16px", color: "#334155", margin: "0 0 16px" } },
            "Hi ", e("strong", null, customerName), ","
          ),
          e(Text, { style: { fontSize: "16px", color: "#334155", lineHeight: "24px", margin: "0 0 24px" } },
            "Payment was successful! Your reservation at ", e("strong", null, businessName), " is confirmed. ",
            "Below are your receipt details and the secure check-in code you will need to present at the front desk."
          ),
          
          e(Hr, { style: { borderColor: "#e2e8f0", margin: "24px 0" } }),
          
          // Receipt Details
          e(Section, null,
            e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, "Reference")
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, publicReference)
              )
            ),
            e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, "Room")
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, servicePointLabel)
              )
            ),
            e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, "Dates")
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, `${checkInDate} to ${checkOutDate}`)
              )
            ),
            e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, "Guests")
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, guestCount)
              )
            ),
            e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, accommodationLabel)
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, formattedSubtotal)
              )
            ),
            formattedTaxAmount ? e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, taxLabel)
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, formattedTaxAmount)
              )
            ) : null,
            formattedPlatformFeeAmount ? e(Row, { style: { marginBottom: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px" } }, platformFeeLabel)
              ),
              e(Column, null,
                e(Text, { style: { color: "#0f172a", margin: 0, fontSize: "14px", fontWeight: "600" } }, formattedPlatformFeeAmount)
              )
            ) : null,
            e(Row, { style: { borderTop: "1px solid #e2e8f0", paddingTop: "12px" } },
              e(Column, { style: { width: "40%" } },
                e(Text, { style: { color: "#64748b", margin: 0, fontSize: "14px", fontWeight: "700" } }, "Total Paid")
              ),
              e(Column, null,
                e(Text, { style: { color: "#16a34a", margin: 0, fontSize: "16px", fontWeight: "700" } }, formattedAmount)
              )
            )
          ),
          
          // Check-In Code
          e(Section, { style: codeBox },
            e(Text, { style: { margin: "0 0 8px", fontSize: "12px", textTransform: "uppercase", fontWeight: "700", color: "#64748b", letterSpacing: "1px" } },
              "Your Check-in Code"
            ),
            e(Text, { style: codeStyle }, checkInCode),
            e(Text, { style: { margin: "16px 0 0", fontSize: "14px", color: "#475569", lineHeight: "20px" } },
              "Valid from ", e("strong", null, validFrom), e("br", null),
              "Expires at ", e("strong", null, expiresAt)
            )
          ),
          
          e(Text, { style: { fontSize: "14px", color: "#64748b", fontStyle: "italic", textAlign: "center" } },
            "For your security, do not share this code with anyone outside your booking party."
          )
        )
      )
    )
  );
}
