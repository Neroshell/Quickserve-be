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
    const subject = `Your QuickServe Receipt - Order #${order.orderId.substring(0, 8).toUpperCase()}`;

    const formattedDate = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const itemsHtml = order.items
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
          ${order.currency} ${item.lineTotal.toFixed(2)}
        </td>
      </tr>
    `
      )
      .join("");

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
                ${order.currency} ${order.total.toFixed(2)}
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
    const mailOptions = {
      from: `"QuickServe" <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
      to: email,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ✅ Receipt sent to ${email} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error("[EmailService] ❌ Error sending receipt:", error);
    return false;
  }
}
