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

const header = {
  backgroundColor: "#ea580c",
  padding: "32px 20px",
  textAlign: "center",
};

const brandText = {
  color: "rgba(255, 255, 255, 0.8)",
  fontSize: "14px",
  fontWeight: "600",
  letterSpacing: "1px",
  textTransform: "uppercase",
  margin: "0 0 8px 0",
};

const headingStyle = {
  color: "#ffffff",
  fontSize: "28px",
  fontWeight: "bold",
  margin: "0 0 8px 0",
};

const subheading = {
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: "16px",
  margin: "0",
};

const businessSection = {
  padding: "32px 20px 20px",
};

const logo = {
  borderRadius: "8px",
  margin: "0 auto 16px",
};

const logoPlaceholder = {
  width: "64px",
  height: "64px",
  borderRadius: "8px",
  backgroundColor: "#f1f5f9",
  margin: "0 auto 16px",
  textAlign: "center",
  lineHeight: "64px",
};

const logoPlaceholderText = {
  fontSize: "24px",
  fontWeight: "bold",
  color: "#94a3b8",
  margin: "0",
  lineHeight: "64px",
};

const businessNameText = {
  fontSize: "20px",
  fontWeight: "600",
  color: "#334155",
  margin: "0",
  textAlign: "center",
};

const detailsSection = {
  padding: "0 32px 24px",
};

const detailLabel = {
  fontSize: "12px",
  color: "#64748b",
  textTransform: "uppercase",
  fontWeight: "600",
  margin: "0 0 4px 0",
};

const detailValue = {
  fontSize: "15px",
  color: "#0f172a",
  fontWeight: "500",
  margin: "0",
};

const divider = {
  borderColor: "#e2e8f0",
  margin: "0",
};

const itemsSection = {
  padding: "24px 32px",
};

const sectionTitle = {
  fontSize: "18px",
  fontWeight: "600",
  color: "#0f172a",
  margin: "0 0 16px 0",
};

const itemRow = {
  marginBottom: "16px",
};

const itemQuantity = {
  fontSize: "15px",
  fontWeight: "600",
  color: "#64748b",
  margin: "0",
};

const itemName = {
  fontSize: "15px",
  fontWeight: "500",
  color: "#0f172a",
  margin: "0",
};

const itemNote = {
  fontSize: "13px",
  color: "#64748b",
  margin: "4px 0 0 0",
  fontStyle: "italic",
};

const itemAllergy = {
  fontSize: "13px",
  color: "#ef4444",
  margin: "4px 0 0 0",
  fontWeight: "500",
};

const itemPrice = {
  fontSize: "15px",
  fontWeight: "500",
  color: "#0f172a",
  margin: "0",
};

const totalsSection = {
  padding: "24px 32px",
};

const totalRow = {
  marginBottom: "8px",
};

const totalLabel = {
  fontSize: "15px",
  color: "#64748b",
  margin: "0",
  paddingRight: "16px",
};

const totalValue = {
  fontSize: "15px",
  color: "#0f172a",
  margin: "0",
};

const grandTotalRow = {
  marginTop: "16px",
  paddingTop: "16px",
  borderTop: "1px solid #e2e8f0",
};

const grandTotalLabel = {
  fontSize: "18px",
  fontWeight: "bold",
  color: "#0f172a",
  margin: "0",
  paddingRight: "16px",
};

const grandTotalValue = {
  fontSize: "18px",
  fontWeight: "bold",
  color: "#ea580c",
  margin: "0",
};

const footer = {
  padding: "32px",
  textAlign: "center",
  backgroundColor: "#f8fafc",
};

const footerText = {
  fontSize: "14px",
  color: "#64748b",
  margin: "0 0 8px 0",
};

const footerLink = {
  fontSize: "14px",
  fontWeight: "600",
  color: "#ea580c",
  margin: "0",
};

function formatPrice(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(amount);
}

export default function ReceiptEmail({
  businessName = "QuickServe",
  businessLogoUrl,
  orderId,
  orderDate,
  servicePointLabel,
  servicePointCode,
  servicePointTerm = "Service Point",
  orderType = "dine-in",
  paymentMethod = "offline",
  paymentStatus = "unpaid",
  currency = "USD",
  items = [],
  subtotal = 0,
  taxAmount = 0,
  serviceFeeAmount = 0,
  tipAmount = 0,
  total = 0,
}) {
  const e = React.createElement;

  const servicePointDisplay = servicePointLabel || servicePointCode || "Unknown";
  const displayOrderType = orderType === "dine-in" ? "Dine-In" : "Takeout";
  const paymentMethodMap = {
    online_card: "Online Card",
    pos_card: "POS / Card",
    cash: "Cash",
    offline: "Pay in person",
  };
  const displayPaymentMethod = paymentMethodMap[paymentMethod] || paymentMethod;
  const displayPaymentStatus = paymentStatus === "paid" ? "Paid" : "Pending / Unpaid";

  return e(Html, null,
    e(Head, null),
    e(Preview, null, `Your receipt from ${businessName} (Order ${orderId})`),
    e(Body, { style: main },
      e(Container, { style: container },

        // Header
        e(Section, { style: header },
          e(Row, null,
            e(Column, { align: "center" },
              e(Text, { style: brandText }, "QuickServe"),
              e(Heading, { style: headingStyle }, "Order Receipt"),
              e(Text, { style: subheading }, "Thank you for your order!")
            )
          )
        ),

        // Business info
        e(Section, { style: businessSection },
          e(Row, null,
            e(Column, { align: "center" },
              businessLogoUrl
                ? e(Img, { src: businessLogoUrl, width: "64", height: "64", alt: businessName, style: logo })
                : e("div", { style: logoPlaceholder },
                    e(Text, { style: logoPlaceholderText }, businessName.charAt(0))
                  ),
              e(Text, { style: businessNameText }, businessName)
            )
          )
        ),

        // Order details
        e(Section, { style: detailsSection },
          e(Row, null,
            e(Column, null,
              e(Text, { style: detailLabel }, "Order ID"),
              e(Text, { style: detailValue }, orderId)
            ),
            e(Column, null,
              e(Text, { style: detailLabel }, "Date"),
              e(Text, { style: detailValue }, orderDate)
            )
          ),
          e(Row, { style: { marginTop: "12px" } },
            e(Column, null,
              e(Text, { style: detailLabel }, 'Service Point'),
              e(Text, { style: detailValue }, servicePointDisplay )
            ),
            e(Column, null,
              e(Text, { style: detailLabel }, "Type"),
              e(Text, { style: detailValue }, displayOrderType)
            )
          ),
          e(Row, { style: { marginTop: "12px" } },
            e(Column, null,
              e(Text, { style: detailLabel }, "Payment Method"),
              e(Text, { style: detailValue }, displayPaymentMethod)
            ),
            e(Column, null,
              e(Text, { style: detailLabel }, "Status"),
              e(Text, { style: detailValue }, displayPaymentStatus)
            )
          )
        ),

        e(Hr, { style: divider }),

        // Items
        e(Section, { style: itemsSection },
          e(Text, { style: sectionTitle }, "Order Items"),
          ...items.map((item, index) =>
            e(Row, { key: index, style: itemRow },
              e(Column, { style: { width: "15%" }, align: "left", valign: "top" },
                e(Text, { style: itemQuantity }, `${item.quantity}x`)
              ),
              e(Column, { style: { width: "60%" }, align: "left", valign: "top" },
                e(Text, { style: itemName }, item.itemName),
                item.notes ? e(Text, { style: itemNote }, `Note: ${item.notes}`) : null,
                item.allergies && item.allergies.length > 0
                  ? e(Text, { style: itemAllergy }, `Allergies: ${item.allergies.join(", ")}`)
                  : null
              ),
              e(Column, { style: { width: "25%" }, align: "right", valign: "top" },
                e(Text, { style: itemPrice }, formatPrice(item.lineTotal, currency))
              )
            )
          )
        ),

        e(Hr, { style: divider }),

        // Totals
        e(Section, { style: totalsSection },
          e(Row, { style: totalRow },
            e(Column, { align: "right" }, e(Text, { style: totalLabel }, "Subtotal")),
            e(Column, { align: "right", style: { width: "80px" } }, e(Text, { style: totalValue }, formatPrice(subtotal, currency)))
          ),
          serviceFeeAmount > 0 ? e(Row, { style: totalRow },
            e(Column, { align: "right" }, e(Text, { style: totalLabel }, "Service Fee")),
            e(Column, { align: "right", style: { width: "80px" } }, e(Text, { style: totalValue }, formatPrice(serviceFeeAmount, currency)))
          ) : null,
          taxAmount > 0 ? e(Row, { style: totalRow },
            e(Column, { align: "right" }, e(Text, { style: totalLabel }, "Tax")),
            e(Column, { align: "right", style: { width: "80px" } }, e(Text, { style: totalValue }, formatPrice(taxAmount, currency)))
          ) : null,
          tipAmount > 0 ? e(Row, { style: totalRow },
            e(Column, { align: "right" }, e(Text, { style: totalLabel }, "Tip")),
            e(Column, { align: "right", style: { width: "80px" } }, e(Text, { style: totalValue }, formatPrice(tipAmount, currency)))
          ) : null,
          e(Row, { style: grandTotalRow },
            e(Column, { align: "right" }, e(Text, { style: grandTotalLabel }, "Total")),
            e(Column, { align: "right", style: { width: "80px" } }, e(Text, { style: grandTotalValue }, formatPrice(total, currency)))
          )
        ),

        e(Hr, { style: divider }),

        // Footer
        e(Section, { style: footer },
          e(Text, { style: footerText }, "Please keep this email for your records."),
          e(Text, { style: footerLink }, "Powered by QuickServe")
        )
      )
    )
  );
}
