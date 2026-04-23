import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail", // You can change this or use SMTP configuration directly
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendReceiptEmail(order, email) {
  try {
    console.log(`[EmailService] Initiating sendReceiptEmail for order: ${order.orderId}, email: ${email}`);
    
    // Explicitly check properties used in email to ensure Mongoose evaluates them correctly or doesn't fail silently
    if (!order.items || !Array.isArray(order.items)) {
       console.error(`[EmailService] ❌ order.items is invalid:`, order.items);
       return false;
    }

    const subject = `Your QuickServe Receipt - Order #${order.orderId.substring(0, 8).toUpperCase()}`;
    console.log(`[EmailService] Subject formed: ${subject}`);

    const formattedDate = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    console.log(`[EmailService] Formatting items HTML...`);
    let itemsHtml;
    try {
      itemsHtml = order.items
        .map(
          (item) => `
        <tr>
          <td style="padding: 14px 0; border-bottom: 1px solid #eceff3;">
            <div style="font-size: 14px; font-weight: 600; color: #0f172a;">
              ${item.itemName}
            </div>
            <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
              Qty: ${item.quantity}
            </div>
          </td>
          <td style="padding: 14px 0; border-bottom: 1px solid #eceff3; text-align: right; font-size: 14px; font-weight: 600; color: #0f172a;">
            ${order.currency || 'EUR'} ${(item.lineTotal || 0).toFixed(2)}
          </td>
        </tr>
      `
        )
        .join("");
      console.log(`[EmailService] Items HTML successfully formatted.`);
    } catch (renderError) {
      console.error(`[EmailService] ❌ Error generating itemsHtml:`, renderError);
      return false;
    }

    console.log(`[EmailService] Formatting full HTML payload... total: ${order.total}, currency: ${order.currency}`);
    let html;
    try {
      html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
  <div style="max-width: 620px; margin: 32px auto; padding: 0 16px;">
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">

      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px 32px 26px; text-align: center;">
        <div style="font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
          QuickServe
        </div>
        <div style="margin-top: 6px; font-size: 13px; color: #ffedd5;">
          Fast, seamless restaurant service
        </div>
      </div>

      <!-- Payment status -->
      <div style="padding: 18px 32px; background: #fff7ed; border-bottom: 1px solid #fed7aa;">
        <div style="font-size: 14px; font-weight: 700; color: #c2410c;">
          Payment confirmed
        </div>
        <div style="margin-top: 4px; font-size: 13px; color: #7c2d12;">
          Thank you. Your order has been received successfully.
        </div>
      </div>

      <!-- Body -->
      <div style="padding: 30px 32px 20px;">
        <h2 style="margin: 0 0 8px; font-size: 22px; line-height: 1.2; color: #0f172a;">
          Your receipt
        </h2>
        <p style="margin: 0 0 22px; font-size: 14px; line-height: 1.6; color: #64748b;">
          Here is a summary of your QuickServe order.
        </p>

        <!-- Order meta -->
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px 20px; margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8;">
                Order Number
              </td>
              <td style="padding: 4px 0; text-align: right; font-size: 14px; font-weight: 700; color: #0f172a;">
                #${order.orderId.substring(0, 8).toUpperCase()}
              </td>
            </tr>
            <tr>
              <td style="padding: 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8;">
                Date
              </td>
              <td style="padding: 4px 0; text-align: right; font-size: 14px; font-weight: 600; color: #0f172a;">
                ${formattedDate}
              </td>
            </tr>
            ${order.tableNumber
        ? `
            <tr>
              <td style="padding: 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8;">
                Table
              </td>
              <td style="padding: 4px 0; text-align: right; font-size: 14px; font-weight: 600; color: #0f172a;">
                Table ${order.tableNumber}
              </td>
            </tr>
            `
        : ""
      }
            ${order.paymentStatus
        ? `
            <tr>
              <td style="padding: 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8;">
                Payment Status
              </td>
              <td style="padding: 4px 0; text-align: right; font-size: 14px; font-weight: 600; color: #0f172a; text-transform: capitalize;">
                ${order.paymentStatus}
              </td>
            </tr>
            `
        : ""
      }
          </table>
        </div>

        <!-- Order summary -->
        <div style="margin-bottom: 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; font-weight: 700;">
          Order Summary
        </div>

        <table style="width: 100%; border-collapse: collapse;">
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <!-- Total -->
        <div style="margin-top: 24px; background: #0f172a; border-radius: 14px; padding: 18px 20px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="font-size: 13px; color: #cbd5e1;">
                Total Paid
              </td>
              <td style="text-align: right; font-size: 24px; font-weight: 800; color: #ffffff;">
                ${order.currency || 'EUR'} ${(order.total || 0).toFixed(2)}
              </td>
            </tr>
          </table>
        </div>

        <!-- Closing note -->
        <div style="margin-top: 22px; padding: 16px 18px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px;">
          <p style="margin: 0; font-size: 13px; line-height: 1.6; color: #7c2d12;">
            Need help with your order? Please ask a member of staff. Thank you for dining with us.
          </p>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding: 0 32px 28px; text-align: center;">
        <p style="margin: 0; font-size: 12px; color: #94a3b8;">
          Powered by <span style="color: #f97316; font-weight: 700;">QuickServe</span>
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`;
      console.log(`[EmailService] Full HTML string generated successfully.`);
    } catch (htmlRenderError) {
      console.error(`[EmailService] ❌ Error generating full HTML payload:`, htmlRenderError);
      return false;
    }

    const mailOptions = {
      from: `"QuickServe" <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
      to: email,
      subject,
      html,
    };

    console.log(`[EmailService] Attempting to sendMail to ${email}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ✅ Receipt sent to ${email} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error("[EmailService] ❌ Transport/Execution Error sending receipt:", error);
    return false;
  }
}

export async function sendInvitationEmail(business, inviteLink) {
  try {
    const { ownerName, ownerEmail, displayName } = business;
    console.log(`[EmailService] Sending invitation to ${ownerEmail} for ${displayName}`);

    const subject = `Welcome to QuickServe - Set up your account for ${displayName}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
  <div style="max-width: 620px; margin: 32px auto; padding: 0 16px;">
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">

      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px 32px 26px; text-align: center;">
        <div style="font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
          QuickServe
        </div>
        <div style="margin-top: 6px; font-size: 13px; color: #ffedd5;">
          Partner Portal Onboarding
        </div>
      </div>

      <!-- Body -->
      <div style="padding: 40px 32px 30px;">
        <h2 style="margin: 0 0 16px; font-size: 24px; line-height: 1.2; color: #0f172a;">
          Hello ${ownerName},
        </h2>
        <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #334155;">
          Your business account for <strong>${displayName}</strong> has been successfully created on QuickServe.
        </p>
        <p style="margin: 0 0 30px; font-size: 16px; line-height: 1.6; color: #334155;">
          To get started and access your dashboard, please set up your account password by clicking the button below:
        </p>

        <!-- CTA Button -->
        <div style="text-align: center; margin-bottom: 35px;">
          <a href="${inviteLink}" style="background-color: #ea580c; color: #ffffff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(234, 88, 12, 0.25);">
            Set Up Your Password
          </a>
        </div>

        <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <p style="margin: 0; font-size: 14px; color: #64748b; line-height: 1.5;">
            <strong>Note:</strong> This invitation link will expire in 48 hours for security reasons. If you didn't expect this email, you can safely ignore it.
          </p>
        </div>

        <p style="margin: 0; font-size: 15px; color: #334155;">
          If the button above doesn't work, copy and paste this URL into your browser:
        </p>
        <p style="margin: 8px 0 0; font-size: 13px; color: #f97316; word-break: break-all;">
          ${inviteLink}
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 0 32px 30px; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 25px;">
        <p style="margin: 0; font-size: 12px; color: #94a3b8;">
          &copy; 2026 QuickServe Platform. All rights reserved.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
        `;

    const mailOptions = {
      from: `"QuickServe" <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
      to: ownerEmail,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ✅ Invitation sent to ${ownerEmail} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error("[EmailService] ❌ Error sending invitation email:", error);
    return false;
  }
}

export async function sendStaffInvitationEmail(staff, inviteLink) {
  try {
    const { name, email } = staff;
    console.log(`[EmailService] Sending staff invitation to ${email} for ${name}`);

    const subject = `You've been added as Staff on QuickServe`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
  <div style="max-width: 620px; margin: 32px auto; padding: 0 16px;">
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">

      <!-- Header -->
      <div style="background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 30px 32px 26px; text-align: center;">
        <div style="font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
          QuickServe
        </div>
        <div style="margin-top: 6px; font-size: 13px; color: #e0f2fe;">
          Staff Onboarding
        </div>
      </div>

      <!-- Body -->
      <div style="padding: 40px 32px 30px;">
        <h2 style="margin: 0 0 16px; font-size: 24px; line-height: 1.2; color: #0f172a;">
          Hello ${name},
        </h2>
        <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #334155;">
          You have been added as a member of the <strong>Staff</strong> for a business on QuickServe.
        </p>
        <p style="margin: 0 0 30px; font-size: 16px; line-height: 1.6; color: #334155;">
          To get started and access your staff dashboard, please set up your account password by clicking the button below:
        </p>

        <!-- CTA Button -->
        <div style="text-align: center; margin-bottom: 35px;">
          <a href="${inviteLink}" style="background-color: #0284c7; color: #ffffff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.25);">
            Set Up Your Account
          </a>
        </div>

        <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <p style="margin: 0; font-size: 14px; color: #64748b; line-height: 1.5;">
            <strong>Note:</strong> This invitation link will expire in 48 hours for security reasons. If you didn't expect this email, you can safely ignore it.
          </p>
        </div>

        <p style="margin: 0; font-size: 15px; color: #334155;">
          If the button above doesn't work, copy and paste this URL into your browser:
        </p>
        <p style="margin: 8px 0 0; font-size: 13px; color: #0284c7; word-break: break-all;">
          ${inviteLink}
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 0 32px 30px; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 25px;">
        <p style="margin: 0; font-size: 12px; color: #94a3b8;">
          &copy; 2026 QuickServe Platform. All rights reserved.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
        `;

    const mailOptions = {
      from: `"QuickServe" <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
      to: email,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ✅ Staff invitation sent to ${email} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error("[EmailService] ❌ Error sending staff invitation email:", error);
    return false;
  }
}

export async function sendPasswordResetEmail(email, name, resetLink) {
  try {
    console.log(`[EmailService] Sending password reset to ${email} for ${name || 'User'}`);

    const subject = `Reset Your QuickServe Password`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
  <div style="max-width: 620px; margin: 32px auto; padding: 0 16px;">
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">

      <!-- Header -->
      <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding: 30px 32px 26px; text-align: center;">
        <div style="font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
          QuickServe
        </div>
        <div style="margin-top: 6px; font-size: 13px; color: #94a3b8;">
          Account Security
        </div>
      </div>

      <!-- Body -->
      <div style="padding: 40px 32px 30px;">
        <h2 style="margin: 0 0 16px; font-size: 24px; line-height: 1.2; color: #0f172a;">
          Hello ${name || 'there'},
        </h2>
        <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #334155;">
          We received a request to reset the password associated with your QuickServe account.
        </p>
        <p style="margin: 0 0 30px; font-size: 16px; line-height: 1.6; color: #334155;">
          You can reset your password immediately by clicking the button below:
        </p>

        <!-- CTA Button -->
        <div style="text-align: center; margin-bottom: 35px;">
          <a href="${resetLink}" style="background-color: #0f172a; color: #ffffff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);">
            Reset Password
          </a>
        </div>

        <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
          <p style="margin: 0; font-size: 14px; color: #64748b; line-height: 1.5;">
            <strong>Note:</strong> This link will expire in 1 hour for your security. If you did not request a password reset, you can safely ignore this email and your password will remain unchanged.
          </p>
        </div>

        <p style="margin: 0; font-size: 15px; color: #334155;">
          If the button above doesn't work, copy and paste this URL into your browser:
        </p>
        <p style="margin: 8px 0 0; font-size: 13px; color: #475569; word-break: break-all;">
          ${resetLink}
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 0 32px 30px; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 25px;">
        <p style="margin: 0; font-size: 12px; color: #94a3b8;">
          &copy; 2026 QuickServe Platform. All rights reserved.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
    `;

    const mailOptions = {
      from: `"QuickServe" <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
      to: email,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ✅ Password reset sent to ${email} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error("[EmailService] ❌ Error sending password reset email:", error);
    return false;
  }
}

