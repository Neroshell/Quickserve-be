import React from "react";
import { Link, Section, Text } from "@react-email/components";

export function normalizeBusinessAddress(address) {
  if (typeof address !== "string") return "";
  return address.trim();
}

export function getGoogleMapsSearchUrl(address) {
  const normalizedAddress = normalizeBusinessAddress(address);
  if (!normalizedAddress) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(normalizedAddress)}`;
}

/**
 * An opt-in, email-safe venue location block. Callers pass the persisted
 * Business.address value; there is no address lookup or client-side logic.
 */
export default function BusinessLocationSection({ address }) {
  const normalizedAddress = normalizeBusinessAddress(address);
  const mapUrl = getGoogleMapsSearchUrl(normalizedAddress);
  if (!mapUrl) return null;

  return React.createElement(
    Section,
    { style: locationSection },
    React.createElement(Text, { style: locationLabel }, "Location"),
    React.createElement(
      Link,
      { href: mapUrl, style: addressLink },
      normalizedAddress,
    ),
    React.createElement(
      Text,
      { style: mapsLinkRow },
      React.createElement(
        Link,
        { href: mapUrl, style: mapsLink },
        "View on Google Maps",
      ),
    ),
  );
}

const locationSection = {
  backgroundColor: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  margin: "0 0 24px",
  padding: "16px 20px",
};

const locationLabel = {
  color: "#64748b",
  fontSize: "13px",
  fontWeight: "700",
  letterSpacing: "0.5px",
  margin: "0 0 8px",
  textTransform: "uppercase",
};

const addressLink = {
  color: "#0f172a",
  display: "inline-block",
  fontSize: "14px",
  fontWeight: "600",
  lineHeight: "21px",
  overflowWrap: "anywhere",
  textDecoration: "underline",
  wordBreak: "break-word",
};

const mapsLinkRow = {
  margin: "10px 0 0",
};

const mapsLink = {
  color: "#c2410c",
  fontSize: "14px",
  fontWeight: "600",
  lineHeight: "20px",
  textDecoration: "underline",
};
