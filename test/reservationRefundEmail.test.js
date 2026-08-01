import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { render } from "@react-email/render"
import ReservationRefundEmail from "../emails/ReservationRefundEmail.js"
import { getReservationRefundEmailIdempotencyKey } from "../src/utils/emailService.js"

test("successful reservation refund email explains amount, retained balance, and expected card timeline", async () => {
    const html = await render(
        React.createElement(ReservationRefundEmail, {
            businessName: "Example Hotel",
            reservation: {
                _id: "reservation-1",
                publicReference: "QS-HOTEL-1",
                customerName: "Guest One",
                checkInDate: "2026-08-10",
                checkOutDate: "2026-08-12",
                currency: "EUR",
                refundedAmountCents: 12000,
            },
            refund: {
                originalPaidAmountCents: 30000,
                requestedAmountCents: 12000,
                successfulAmountCents: 12000,
                currency: "eur",
            },
        }),
    )

    assert.match(html, /Refund Confirmed/)
    assert.match(html, /QS-HOTEL-1/)
    assert.match(html, /Refund issued/)
    assert.match(html, /€120\.00/)
    assert.match(html, /Payment retained/)
    assert.match(html, /€180\.00/)
    assert.match(html, /5–10 business days/)
    assert.doesNotMatch(html, /card number|cvv|cvc/i)
})

test("refund email provider idempotency is stable per tenant refund ledger entry", () => {
    const refund = {
        businessId: "hotel-1",
        refundId: "RF-ABC",
    }
    assert.equal(
        getReservationRefundEmailIdempotencyKey(refund),
        "reservation-refund/hotel-1/RF-ABC",
    )
    assert.equal(
        getReservationRefundEmailIdempotencyKey(refund),
        getReservationRefundEmailIdempotencyKey(refund),
    )
})
