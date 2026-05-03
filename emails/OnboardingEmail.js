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
  Button,
} from "@react-email/components";

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
  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
  maxWidth: "600px",
  overflow: "hidden",
};

const headingStyle = {
  color: "#ffffff",
  fontSize: "24px",
  fontWeight: "bold",
  margin: "0 0 8px 0",
};

const subheading = {
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: "15px",
  margin: "0",
};

const content = {
  padding: "32px 20px",
};

const greetingStyle = {
  fontSize: "18px",
  color: "#0f172a",
  fontWeight: "600",
  marginBottom: "16px",
};

const text = {
  fontSize: "15px",
  color: "#334155",
  lineHeight: "24px",
  marginBottom: "16px",
};

const buttonContainer = {
  textAlign: "center",
  margin: "32px 0",
};

const footerText = {
  fontSize: "14px",
  color: "#64748b",
  marginTop: "32px",
  lineHeight: "22px",
};

export default function OnboardingEmail({ userName, businessName, inviteLink, role }) {
  const e = React.createElement;
  const isOwner = role === "owner";
  const headerColor = isOwner ? "#ea580c" : "#0284c7";
  const headerSubtitle = isOwner ? "Partner Portal Onboarding" : "Staff Onboarding";

  const headerStyle = {
    backgroundColor: headerColor,
    padding: "32px 20px",
    textAlign: "center",
  };

  const buttonStyle = {
    backgroundColor: headerColor,
    color: "#ffffff",
    padding: "12px 24px",
    borderRadius: "6px",
    fontWeight: "bold",
    textDecoration: "none",
    display: "inline-block",
  };

  const introText = isOwner
    ? `Your business account for ${businessName} has been successfully created on QuickServe.`
    : "You have been added as a member of the Staff for a business on QuickServe.";

  return e(Html, null,
    e(Head, null),
    e(Preview, null, "Set up your QuickServe account"),
    e(Body, { style: main },
      e(Container, { style: container },
        e(Section, { style: headerStyle },
          e(Heading, { style: headingStyle }, "QuickServe"),
          e(Text, { style: subheading }, headerSubtitle)
        ),
        e(Section, { style: content },
          e(Text, { style: greetingStyle }, `Hello ${userName},`),
          e(Text, { style: text }, introText),
          e(Text, { style: text }, "To access your dashboard, please set up your account password by clicking the button below:"),
          e(Section, { style: buttonContainer },
            e(Button, { href: inviteLink, style: buttonStyle }, "Set Up Your Password")
          ),
          e(Text, { style: footerText }, "Welcome aboard! The QuickServe Team")
        )
      )
    )
  );
}
