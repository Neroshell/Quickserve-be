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

type ReceiptItem = {
  itemName: string;
  quantity: number;
  lineTotal: number;
  notes?: string;
  allergies?: string[];
};

export type ReceiptEmailProps = {
  businessName: string;
  businessLogoUrl?: string;
  orderId: string;
  orderDate: string;
  servicePointLabel?: string;
  servicePointCode?: string;
  servicePointTerm?: "Table" | "Room";
  orderType: string;
  paymentMethod: string;
  paymentStatus: string;
  currency: string;
  items: ReceiptItem[];
  subtotal: number;
  taxAmount?: number;
  total: number;
};

const formatPrice = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
  }).format(amount);
};

export default function ReceiptEmail({
  businessName = "QuickServe",
  businessLogoUrl,
  orderId,
  orderDate,
  servicePointLabel,
  servicePointCode,
  servicePointTerm = "Table",
  orderType = "dine-in",
  paymentMethod = "offline",
  paymentStatus = "unpaid",
  currency = "USD",
  items = [],
  subtotal = 0,
  taxAmount = 0,
  total = 0,
}: ReceiptEmailProps) {
  const servicePointDisplay = servicePointLabel || servicePointCode || "Unknown";
  
  // Clean up order type for display
  const displayOrderType = orderType === "dine-in" ? "Dine-In" : "Takeout";
  
  // Format payment method
  const displayPaymentMethod = {
    online_card: "Online Card",
    pos_card: "POS / Card",
    cash: "Cash",
    offline: "Pay in person"
  }[paymentMethod] || paymentMethod;

  const displayPaymentStatus = paymentStatus === "paid" ? "Paid" : "Pending / Unpaid";

  return (
    <Html>
      <Head />
      <Preview>Your receipt from {businessName} (Order {orderId})</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Row>
              <Column align="center">
                <Text style={brandText}>QuickServe</Text>
                <Heading style={heading}>Order Receipt</Heading>
                <Text style={subheading}>Thank you for your order!</Text>
              </Column>
            </Row>
          </Section>

          {/* Business Info */}
          <Section style={businessSection}>
            <Row>
              <Column align="center">
                {businessLogoUrl ? (
                  <Img src={businessLogoUrl} width="64" height="64" alt={businessName} style={logo} />
                ) : (
                  <div style={logoPlaceholder}>
                    <Text style={logoPlaceholderText}>{businessName.charAt(0)}</Text>
                  </div>
                )}
                <Text style={businessNameText}>{businessName}</Text>
              </Column>
            </Row>
          </Section>

          {/* Order Details */}
          <Section style={detailsSection}>
            <Row>
              <Column>
                <Text style={detailLabel}>Order ID</Text>
                <Text style={detailValue}>{orderId}</Text>
              </Column>
              <Column>
                <Text style={detailLabel}>Date</Text>
                <Text style={detailValue}>{orderDate}</Text>
              </Column>
            </Row>
            <Row style={{ marginTop: "12px" }}>
              <Column>
                <Text style={detailLabel}>{servicePointTerm}</Text>
                <Text style={detailValue}>{servicePointDisplay}</Text>
              </Column>
              <Column>
                <Text style={detailLabel}>Type</Text>
                <Text style={detailValue}>{displayOrderType}</Text>
              </Column>
            </Row>
            <Row style={{ marginTop: "12px" }}>
              <Column>
                <Text style={detailLabel}>Payment Method</Text>
                <Text style={detailValue}>{displayPaymentMethod}</Text>
              </Column>
              <Column>
                <Text style={detailLabel}>Status</Text>
                <Text style={detailValue}>{displayPaymentStatus}</Text>
              </Column>
            </Row>
          </Section>

          <Hr style={divider} />

          {/* Items */}
          <Section style={itemsSection}>
            <Text style={sectionTitle}>Order Items</Text>
            {items.map((item, index) => (
              <Row key={index} style={itemRow}>
                <Column style={{ width: "15%" }} align="left" valign="top">
                  <Text style={itemQuantity}>{item.quantity}x</Text>
                </Column>
                <Column style={{ width: "60%" }} align="left" valign="top">
                  <Text style={itemName}>{item.itemName}</Text>
                  {item.notes && <Text style={itemNote}>Note: {item.notes}</Text>}
                  {item.allergies && item.allergies.length > 0 && (
                    <Text style={itemAllergy}>Allergies: {item.allergies.join(", ")}</Text>
                  )}
                </Column>
                <Column style={{ width: "25%" }} align="right" valign="top">
                  <Text style={itemPrice}>{formatPrice(item.lineTotal, currency)}</Text>
                </Column>
              </Row>
            ))}
          </Section>

          <Hr style={divider} />

          {/* Totals */}
          <Section style={totalsSection}>
            <Row style={totalRow}>
              <Column align="right">
                <Text style={totalLabel}>Subtotal</Text>
              </Column>
              <Column align="right" style={{ width: "80px" }}>
                <Text style={totalValue}>{formatPrice(subtotal, currency)}</Text>
              </Column>
            </Row>
            {taxAmount > 0 && (
              <Row style={totalRow}>
                <Column align="right">
                  <Text style={totalLabel}>Tax</Text>
                </Column>
                <Column align="right" style={{ width: "80px" }}>
                  <Text style={totalValue}>{formatPrice(taxAmount, currency)}</Text>
                </Column>
              </Row>
            )}
            <Row style={grandTotalRow}>
              <Column align="right">
                <Text style={grandTotalLabel}>Total</Text>
              </Column>
              <Column align="right" style={{ width: "80px" }}>
                <Text style={grandTotalValue}>{formatPrice(total, currency)}</Text>
              </Column>
            </Row>
          </Section>

          <Hr style={divider} />

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>Please keep this email for your records.</Text>
            <Text style={footerLink}>Powered by QuickServe</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
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
  textAlign: "center" as const,
};

const brandText = {
  color: "rgba(255, 255, 255, 0.8)",
  fontSize: "14px",
  fontWeight: "600",
  letterSpacing: "1px",
  textTransform: "uppercase" as const,
  margin: "0 0 8px 0",
};

const heading = {
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
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
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
};

const detailsSection = {
  padding: "0 32px 24px",
};

const detailLabel = {
  fontSize: "12px",
  color: "#64748b",
  textTransform: "uppercase" as const,
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
  textAlign: "center" as const,
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
