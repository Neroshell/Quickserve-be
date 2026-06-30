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
  Hr,
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

const header = {
  backgroundColor: "#1e293b",
  padding: "32px 20px",
  textAlign: "center",
};

const headingStyle = {
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

const emailRow = {
  backgroundColor: "#f8fafc",
  borderRadius: "6px",
  padding: "16px 20px",
  marginBottom: "16px",
  border: "1px solid #e2e8f0",
};

const emailLabel = {
  fontSize: "12px",
  color: "#64748b",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "0 0 4px 0",
};

const emailValue = {
  fontSize: "15px",
  color: "#0f172a",
  fontWeight: "600",
  margin: "0",
};

const buttonContainer = {
  textAlign: "center",
  margin: "32px 0",
};

const button = {
  backgroundColor: "#ea601a",
  color: "#ffffff",
  padding: "14px 28px",
  borderRadius: "6px",
  fontWeight: "bold",
  textDecoration: "none",
  display: "inline-block",
  fontSize: "15px",
};

const footerText = {
  fontSize: "13px",
  color: "#64748b",
  marginTop: "16px",
  fontStyle: "italic",
};

const warningText = {
  fontSize: "13px",
  color: "#dc2626",
  marginTop: "16px",
  fontWeight: "500",
};

/**
 * EmailChangeEmail — used in two modes:
 *   mode="verify"   → sent to new email with confirm link
 *   mode="notify"   → sent to old email as a security alert
 */
export default function EmailChangeEmail({ mode = "verify", userName, confirmLink, oldEmail, newEmail }) {
  const e = React.createElement;

  if (mode === "notify") {
    return e(Html, null,
      e(Head, null),
      e(Preview, null, "Your QuickServe login email has been changed"),
      e(Body, { style: main },
        e(Container, { style: container },
          e(Section, { style: header },
            e(Heading, { style: headingStyle }, "QuickServe")
          ),
          e(Section, { style: content },
            e(Text, { style: greeting }, `Hello ${userName || "there"},`),
            e(Text, { style: text }, "This is a security notification. The login email for your QuickServe account has been successfully changed."),
            e(Section, { style: emailRow },
              e(Text, { style: emailLabel }, "Previous Email"),
              e(Text, { style: emailValue }, oldEmail)
            ),
            e(Section, { style: emailRow },
              e(Text, { style: emailLabel }, "New Email"),
              e(Text, { style: emailValue }, newEmail)
            ),
            e(Hr, null),
            e(Text, { style: warningText }, "If you did not make this change, contact QuickServe support immediately.")
          )
        )
      )
    );
  }

  // mode === "verify"
  return e(Html, null,
    e(Head, null),
    e(Preview, null, "Confirm your new QuickServe login email"),
    e(Body, { style: main },
      e(Container, { style: container },
        e(Section, { style: header },
          e(Heading, { style: headingStyle }, "QuickServe")
        ),
        e(Section, { style: content },
          e(Text, { style: greeting }, `Hello ${userName || "there"},`),
          e(Text, { style: text }, "We received a request to change the login email for your QuickServe account."),
          e(Section, { style: emailRow },
            e(Text, { style: emailLabel }, "Current Email"),
            e(Text, { style: emailValue }, oldEmail)
          ),
          e(Section, { style: emailRow },
            e(Text, { style: emailLabel }, "New Email"),
            e(Text, { style: emailValue }, newEmail)
          ),
          e(Text, { style: text }, "To confirm this change, click the button below:"),
          e(Section, { style: buttonContainer },
            e(Button, { href: confirmLink, style: button }, "Confirm Email Change")
          ),
          e(Text, { style: footerText }, "This link expires in 30 minutes."),
          e(Text, { style: footerText }, "If you didn't request this, you can safely ignore this email — your email will not be changed.")
        )
      )
    )
  );
}
