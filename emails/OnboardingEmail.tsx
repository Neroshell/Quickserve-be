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
  Button,
} from "@react-email/components";

export type OnboardingEmailProps = {
  userName: string;
  businessName?: string;
  inviteLink: string;
  role: "owner" | "staff";
};

export default function OnboardingEmail({
  userName,
  businessName,
  inviteLink,
  role,
}: OnboardingEmailProps) {
  const isOwner = role === "owner";
  
  // Design elements differ based on role
  const headerColor = isOwner ? "#ea580c" : "#0284c7";
  const headerSubtitle = isOwner ? "Partner Portal Onboarding" : "Staff Onboarding";
  
  const greeting = `Hello ${userName},`;
  const introText = isOwner
    ? `Your business account for **${businessName}** has been successfully created on QuickServe.`
    : `You have been added as a member of the Staff for a business on QuickServe.`;

  return (
    <Html>
      <Head />
      <Preview>Set up your QuickServe account</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={{ ...header, backgroundColor: headerColor }}>
            <Heading style={heading}>QuickServe</Heading>
            <Text style={subheading}>{headerSubtitle}</Text>
          </Section>
          <Section style={content}>
            <Text style={greetingStyle}>{greeting}</Text>
            {isOwner ? (
              <Text style={text}>
                Your business account for <strong>{businessName}</strong> has been successfully created on QuickServe.
              </Text>
            ) : (
              <Text style={text}>{introText}</Text>
            )}
            <Text style={text}>
              To access your dashboard, please set up your account password by clicking the button below:
            </Text>
            <Section style={buttonContainer}>
              <Button href={inviteLink} style={{ ...button, backgroundColor: headerColor }}>
                Set Up Your Password
              </Button>
            </Section>
            <Text style={footerText}>
              Welcome aboard!
              <br />
              The QuickServe Team
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

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

const header = {
  padding: "32px 20px",
  textAlign: "center" as const,
};

const heading = {
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
  textAlign: "center" as const,
  margin: "32px 0",
};

const button = {
  color: "#ffffff",
  padding: "12px 24px",
  borderRadius: "6px",
  fontWeight: "bold",
  textDecoration: "none",
  display: "inline-block",
};

const footerText = {
  fontSize: "14px",
  color: "#64748b",
  marginTop: "32px",
  lineHeight: "22px",
};
