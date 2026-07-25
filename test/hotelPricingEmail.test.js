import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "@react-email/render";

import HotelPaymentConfirmationEmail from "../emails/HotelPaymentConfirmationEmail.js";

test("hotel confirmation receipt renders applicable tax and customer fee rows", async () => {
  const html = await render(React.createElement(HotelPaymentConfirmationEmail, {
    accommodationLabel: "Accommodation (€100.00 × 2 nights)",
    formattedSubtotal: "€200.00",
    taxLabel: "Tax (19%)",
    formattedTaxAmount: "€38.00",
    platformFeeLabel: "Service Fee",
    formattedPlatformFeeAmount: "€3.00",
    formattedAmount: "€241.00",
  }));

  assert.match(html, /Accommodation/);
  assert.match(html, /Tax \(19%\)/);
  assert.match(html, /Service Fee/);
  assert.match(html, /€241\.00/);
});

test("hotel confirmation receipt omits zero tax and customer fee rows", async () => {
  const html = await render(React.createElement(HotelPaymentConfirmationEmail, {
    formattedSubtotal: "€200.00",
    formattedAmount: "€200.00",
    formattedTaxAmount: null,
    formattedPlatformFeeAmount: null,
  }));

  assert.doesNotMatch(html, />Tax</);
  assert.doesNotMatch(html, />Platform Fee</);
  assert.match(html, /€200\.00/);
});
