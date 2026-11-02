import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("guest receipt and hotel confirmation use the canonical business branding logo with legacy fallback", async () => {
  const service = await read("src/utils/emailService.js")
  assert.match(service, /business\?\.branding\?\.logoUrl \|\| business\?\.logoUrl/)
})

test("reservation calls to action retain a centred client-compatible button", async () => {
  const template = await read("emails/ReservationEmailBase.js")
  assert.match(template, /textAlign: "center", margin: "32px 0"/)
  assert.match(template, /margin: "0 auto"/)
  assert.match(template, /Powered by Chillow/)
})

test("guest branding keeps the venue name but never invents a placeholder logo", async () => {
  const [receipt, reservation, hotel] = await Promise.all([
    read("emails/ReceiptEmail.js"),
    read("emails/ReservationEmailBase.js"),
    read("emails/HotelPaymentConfirmationEmail.js"),
  ])
  for (const template of [receipt, reservation, hotel]) {
    assert.match(template, /isSafeBusinessLogoUrl/)
    assert.match(template, /hasBusinessLogo\s*\?/) 
    assert.match(template, /businessName/)
  }
  assert.doesNotMatch(receipt, /logoPlaceholder \},\s*e\(Text/)
  assert.match(receipt, /width: "64", height: "64"/)
  assert.match(receipt, /function PaymentStatusBadge/)
  assert.match(receipt, /width: "100%"/)
  assert.match(receipt, /width: "auto"/)
  assert.doesNotMatch(receipt, /width: "90%"/)
})

test("all reservation lifecycle variants use the shared status-aware Chillow shell", async () => {
  const names = [
    "ReservationRequestReceivedEmail.js",
    "ReservationConfirmedEmail.js",
    "ReservationPaymentEmail.js",
    "ReservationCancelledEmail.js",
    "ReservationRefundEmail.js",
    "ReservationArrivalReminderEmail.js",
  ]
  const templates = await Promise.all(names.map((name) => read(`emails/${name}`)))
  templates.forEach((template) => assert.match(template, /statusNotice/))
})

test("billing notifications use the table-based Chillow shell and retain explicit states", async () => {
  const billing = await read("src/services/email/billingEmailDeliveryService.js")
  assert.match(billing, /function renderBillingEmail/)
  assert.match(billing, /role="presentation"/)
  assert.match(billing, /Action needed: Chillow payment overdue/)
  assert.doesNotMatch(billing, /QuickServe Payment Successful/)
})
