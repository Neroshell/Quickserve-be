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

export type AuthEmailProps = {
  userName?: string;
  resetLink: string;
};

export default function AuthEmail({ userName, resetLink }: AuthEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your QuickServe password</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={heading}>QuickServe</Heading>
          </Section>
          <Section style={content}>
            <Text style={greeting}>Hello {userName || "there"},</Text>
            <Text style={text}>
              We received a request to reset the password associated with your QuickServe account.
            </Text>
            <Text style={text}>
              You can reset your password immediately by clicking the button below:
            </Text>
            <Section style={buttonContainer}>
              <Button href={resetLink} style={button}>
                Reset Password
              </Button>
            </Section>
            <Text style={footerText}>
              If you did not request this, please ignore this email.
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
  backgroundColor: "#1e293b",
  padding: "32px 20px",
  textAlign: "center" as const,
};

const heading = {
  color: "#ffffff",
  fontSize: "24px",
  fontWeight: "bold",
  margin: "0",
};

const content = {
  padding: "32px 20px",
};

const greeting = {
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
  backgroundColor: "#0f172a",
  color: "#ffffff",
  padding: "12px 24px",
  borderRadius: "6px",
  fontWeight: "bold",
  textDecoration: "none",
  display: "inline-block",
};

const footerText = {
  fontSize: "13px",
  color: "#64748b",
  marginTop: "32px",
  fontStyle: "italic",
};
