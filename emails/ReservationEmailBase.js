import React from "react";
import { isSafeBusinessLogoUrl } from "./emailPresentationUtils.js";
import BusinessLocationSection, { normalizeBusinessAddress } from "./BusinessLocationSection.js";
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
  Button,
  Link,
} from "@react-email/components";

/**
 * Shared, branded layout for all customer-facing reservation emails.
 *
 * New lifecycle emails (reminders, seated, completed, review request, …) should
 * be built on top of this component — pass a different `title`, `intro`,
 * `closing`, and `detailsTitle` and the branded shell stays consistent.
 *
 * @param {object} props
 * @param {string} props.businessName        - Restaurant display name (the "from" identity)
 * @param {string} [props.businessLogoUrl]   - Optional logo URL
 * @param {string} [props.primaryColor]      - Optional brand colour (hex); falls back to Chillow orange
 * @param {string} props.previewText         - Inbox preview line
 * @param {string} props.title               - Header headline (e.g. "Reservation Confirmed")
 * @param {string} props.customerName        - Recipient's name for the greeting
 * @param {Array<string|React.ReactNode>} [props.intro]   - Paragraphs shown above the details box
 * @param {string} [props.detailsTitle]      - Heading for the details box
 * @param {Array<{label:string,value:any}>} [props.details] - Detail rows (rows with falsy value are skipped)
 * @param {{address:string}|null} [props.location] - Explicit opt-in venue location
 * @param {Array<string|React.ReactNode>} [props.closing]  - Paragraphs shown below the details box
 */
export default function ReservationEmailBase({
  businessName = "Chillow",
  businessLogoUrl,
  previewText,
  title,
  customerName,
  intro = [],
  detailsTitle = "Reservation Details",
  details = [],
  location = null,
  closing = [],
  /** Optional explicit lifecycle status: { text: string, tone?: 'info'|'success'|'warning'|'danger' } */
  statusNotice = null,
  /** Optional CTA button: { text: string, url: string } */
  callToAction = null,
  /** Optional link shown beneath the primary CTA: { text: string, url: string } */
  secondaryAction = null,
  /** Optional guest cancellation CTA: { text: string, url: string, label?: string, copy?: string } */
  cancelAction = null,
}) {
  const e = React.createElement;
  // Tenant colours are not guaranteed to meet contrast requirements. Keep the
  // platform CTA colour stable rather than placing white text over arbitrary
  // business colours in an email client.
  const brand = "#c2410c";
  const hasBusinessLogo = isSafeBusinessLogoUrl(businessLogoUrl);
  const locationAddress = normalizeBusinessAddress(location?.address);

  const visibleDetails = details.filter((d) => d && d.value !== null && d.value !== undefined && d.value !== "");

  return e(Html, null,
    e(Head, null),
    e(Preview, null, previewText || title),
    e(Body, { style: main },
      e(Container, { style: container },

        // Branded header
        e(Section, { style: header },
          e(Row, null,
            e(Column, { align: "center" },
              e(Text, { style: brandText }, businessName),
              e(Heading, { style: headingStyle }, title)
            )
          )
        ),

        // Business identity (logo + name)
        e(Section, { style: businessSection },
          e(Row, null,
            e(Column, { align: "center" },
              hasBusinessLogo
                ? e(Img, { src: businessLogoUrl, width: "40", height: "40", alt: `${businessName} logo`, style: logo })
                : null,
              e(Text, { style: businessNameText }, businessName)
            )
          )
        ),

        // Greeting + intro
        e(Section, { style: bodySection },
          e(Text, { style: greeting }, `Hello ${customerName || "there"},`),
          ...intro.map((p, i) => e(Text, { key: `intro-${i}`, style: paragraph }, p)),
          statusNotice ? e(Text, { style: { ...statusNoticeStyle, ...statusToneStyles[statusNotice.tone] } }, statusNotice.text) : null
        ),

        // Details box
        visibleDetails.length > 0
          ? e(Section, { style: detailsOuter },
              e(Section, { style: detailsBox },
                detailsTitle ? e(Text, { style: detailsHeading }, detailsTitle) : null,
                ...visibleDetails.map((d, i) =>
                  e(Row, { key: `detail-${i}`, style: detailRow },
                    e(Column, { style: { width: "40%" } },
                      e(Text, { style: detailLabel }, d.label)
                    ),
                    e(Column, { style: { width: "60%" } },
                      e(Text, { style: detailValue }, String(d.value))
                    )
                  )
                )
              )
            )
          : null,

        // Location is deliberately opt-in so lifecycle emails only show it
        // where the guest needs venue directions.
        locationAddress
          ? e(Section, { style: locationOuter },
              e(BusinessLocationSection, { address: locationAddress })
            )
          : null,

        // Call To Action
        callToAction
          ? e(Section, { style: { textAlign: "center", margin: "32px 0" } },
              e(Button, { href: callToAction.url, style: { ...buttonStyle, backgroundColor: brand } }, callToAction.text)
            )
          : null,

        secondaryAction
          ? e(Section, { style: { textAlign: "center", margin: "-18px 0 28px" } },
              e(Link, { href: secondaryAction.url, style: { ...secondaryLink, color: brand } }, secondaryAction.text)
            )
          : null,

        cancelAction
          ? e(Section, { style: { textAlign: "center", margin: "20px 0 28px", padding: "0 20px" } },
              cancelAction.label ? e(Text, { style: cancelLabelStyle }, cancelAction.label) : null,
              cancelAction.copy ? e(Text, { style: cancelCopyStyle }, cancelAction.copy) : null,
              e(Button, { href: cancelAction.url, style: cancelButtonStyle }, cancelAction.text)
            )
          : null,

        // Closing
        closing.length > 0
          ? e(Section, { style: bodySection },
              ...closing.map((p, i) => e(Text, { key: `closing-${i}`, style: paragraph }, p)),
              e(Text, { style: signOff }, businessName)
            )
          : e(Section, { style: bodySection },
              e(Text, { style: signOff }, businessName)
            ),

        e(Hr, { style: divider }),

        // Footer
        e(Section, { style: footer },
          e(Text, { style: footerText }, "Powered by Chillow")
        )
      )
    )
  );
}

/** Format a "YYYY-MM-DD" reservation date as e.g. "Thursday, June 11, 2026". */
export function formatReservationDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Append an 8-bit alpha suffix to a 6-digit hex colour (e.g. "#ff8800" + "1a"). */
function hexWithAlpha(hex, alpha) {
  if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return `${hex}${alpha}`;
  }
  return "#f1f5f9";
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  marginTop: "48px",
  marginBottom: "48px",
  borderRadius: "8px",
  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  maxWidth: "600px",
  overflow: "hidden",
};

const header = {
  borderTop: "4px solid #ea601a",
  padding: "20px 20px 18px",
  textAlign: "center",
  backgroundColor: "#ffffff",
};

const brandText = {
  color: "#64748b",
  fontSize: "12px",
  fontWeight: "600",
  letterSpacing: "1px",
  textTransform: "uppercase",
  margin: "0 0 8px 0",
};

const headingStyle = {
  color: "#0f172a",
  fontSize: "26px",
  fontWeight: "bold",
  margin: "0",
};

const businessSection = {
  padding: "16px 20px 4px",
};

const logo = {
  borderRadius: "8px",
  margin: "0 auto 8px",
};

const logoPlaceholder = {
  width: "64px",
  height: "64px",
  borderRadius: "8px",
  margin: "0 auto 12px",
  textAlign: "center",
  lineHeight: "64px",
};

const logoPlaceholderText = {
  fontSize: "26px",
  fontWeight: "bold",
  margin: "0",
  lineHeight: "64px",
};

const businessNameText = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#334155",
  margin: "0",
  textAlign: "center",
};

const bodySection = {
  padding: "8px 32px",
};

const greeting = {
  fontSize: "16px",
  color: "#0f172a",
  fontWeight: "600",
  margin: "12px 0 12px 0",
};

const paragraph = {
  fontSize: "15px",
  lineHeight: "24px",
  color: "#475569",
  margin: "0 0 14px 0",
};

const statusNoticeStyle = {
  borderRadius: "8px",
  fontSize: "14px",
  fontWeight: "700",
  lineHeight: "20px",
  margin: "4px 0 18px",
  padding: "12px 14px",
};

const statusToneStyles = {
  info: { backgroundColor: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8" },
  success: { backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
  warning: { backgroundColor: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" },
  danger: { backgroundColor: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c" },
};

const detailsOuter = {
  padding: "8px 32px 16px",
};

const detailsBox = {
  backgroundColor: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "20px 24px",
};

const locationOuter = {
  padding: "0 32px",
};

const detailsHeading = {
  fontSize: "13px",
  fontWeight: "700",
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  margin: "0 0 12px 0",
};

const detailRow = {
  marginBottom: "10px",
};

const detailLabel = {
  fontSize: "14px",
  color: "#64748b",
  margin: "0",
};

const detailValue = {
  fontSize: "14px",
  color: "#0f172a",
  fontWeight: "600",
  margin: "0",
};

const divider = {
  borderColor: "#e2e8f0",
  margin: "16px 0 0",
};

const signOff = {
  fontSize: "15px",
  color: "#0f172a",
  fontWeight: "600",
  margin: "18px 0 8px 0",
};

const footer = {
  padding: "20px 32px 28px",
  textAlign: "center",
  backgroundColor: "#f8fafc",
};

const footerText = {
  fontSize: "13px",
  color: "#94a3b8",
  margin: "0",
};

const buttonStyle = {
  backgroundColor: "#ea580c",
  borderRadius: "8px",
  color: "#ffffff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  display: "inline-block",
  margin: "0 auto",
  padding: "12px 24px",
};

const secondaryLink = {
  fontSize: "14px",
  fontWeight: "600",
  textDecoration: "underline",
};

const cancelLabelStyle = {
  fontSize: "14px",
  fontWeight: "600",
  color: "#334155",
  margin: "0 0 4px 0",
};

const cancelCopyStyle = {
  fontSize: "13px",
  color: "#64748b",
  margin: "0 0 12px 0",
  lineHeight: "18px",
};

const cancelButtonStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  color: "#475569",
  fontSize: "14px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  display: "inline-block",
  padding: "10px 20px",
};
