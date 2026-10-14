import assert from "node:assert/strict"
import test from "node:test"

import {
  evaluateBusinessOperatingStatus,
  isBusinessOpen,
} from "../src/utils/operatingHours.js"

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

function weeklySchedule(defaultDay = { enabled: true, openTime: "09:00", closeTime: "17:00" }, overrides = {}) {
  return Object.fromEntries(
    WEEKDAYS.map(day => [day, { ...defaultDay, ...(overrides[day] || {}) }]),
  )
}

function business({ timezone = "UTC", operatingHours = weeklySchedule() } = {}) {
  return { timezone, operatingHours }
}

function statusAt(subject, instant) {
  return evaluateBusinessOperatingStatus(subject, instant).status
}

test("canonical status uses half-open daytime windows", () => {
  const subject = business()

  assert.equal(statusAt(subject, "2026-10-12T08:59:00.000Z"), "closed")
  assert.equal(statusAt(subject, "2026-10-12T09:00:00.000Z"), "open")
  assert.equal(statusAt(subject, "2026-10-12T16:59:00.000Z"), "open")
  assert.equal(statusAt(subject, "2026-10-12T17:00:00.000Z"), "closed")
})

test("closed, missing, malformed, and invalid-timezone schedules fail safely", () => {
  const closedMonday = business({
    operatingHours: weeklySchedule({ enabled: false, openTime: "09:00", closeTime: "17:00" }),
  })
  assert.equal(statusAt(closedMonday, "2026-10-12T12:00:00.000Z"), "closed")

  assert.equal(statusAt({ timezone: "UTC" }, "2026-10-12T12:00:00.000Z"), "unknown")
  assert.equal(statusAt(business({ operatingHours: weeklySchedule(undefined, { Monday: { openTime: "9:00" } }) }), "2026-10-12T12:00:00.000Z"), "unknown")
  assert.equal(statusAt(business({ timezone: "Not/A-Timezone" }), "2026-10-12T12:00:00.000Z"), "unknown")
})

test("previous-day overnight windows carry into the next calendar day", () => {
  const subject = business({
    operatingHours: weeklySchedule(
      { enabled: false, openTime: "09:00", closeTime: "17:00" },
      { Sunday: { enabled: true, openTime: "18:00", closeTime: "02:00" } },
    ),
  })

  assert.equal(statusAt(subject, "2026-10-12T01:59:00.000Z"), "open")
  assert.equal(statusAt(subject, "2026-10-12T02:00:00.000Z"), "closed")
})

test("midnight close is exclusive, while 00:00 to 00:00 retains existing full-day semantics", () => {
  const midnightClose = business({
    operatingHours: weeklySchedule(
      { enabled: false, openTime: "09:00", closeTime: "17:00" },
      { Monday: { enabled: true, openTime: "18:00", closeTime: "00:00" } },
    ),
  })
  assert.equal(statusAt(midnightClose, "2026-10-12T23:59:00.000Z"), "open")
  assert.equal(statusAt(midnightClose, "2026-10-13T00:00:00.000Z"), "closed")

  const fullDay = business({
    operatingHours: weeklySchedule({ enabled: true, openTime: "00:00", closeTime: "00:00" }),
  })
  assert.equal(statusAt(fullDay, "2026-10-12T00:00:00.000Z"), "open")
  assert.equal(statusAt(fullDay, "2026-10-12T23:59:00.000Z"), "open")
})

test("equal non-midnight times are zero-length, not inferred as 24-hour operation", () => {
  const subject = business({
    operatingHours: weeklySchedule(
      { enabled: false, openTime: "09:00", closeTime: "17:00" },
      { Monday: { enabled: true, openTime: "09:00", closeTime: "09:00" } },
    ),
  })

  assert.equal(statusAt(subject, "2026-10-12T09:00:00.000Z"), "closed")
})

test("IANA timezone conversion and DST transitions evaluate an instant deterministically", () => {
  const newYork = business({ timezone: "America/New_York" })
  assert.equal(statusAt(newYork, "2026-07-06T12:59:00.000Z"), "closed")
  assert.equal(statusAt(newYork, "2026-07-06T13:00:00.000Z"), "open")

  const maltaSunday = business({
    timezone: "Europe/Malta",
    operatingHours: weeklySchedule(
      { enabled: false, openTime: "09:00", closeTime: "17:00" },
      { Sunday: { enabled: true, openTime: "01:00", closeTime: "04:00" } },
    ),
  })
  assert.equal(statusAt(maltaSunday, "2026-03-29T00:30:00.000Z"), "open")
  assert.equal(statusAt(maltaSunday, "2026-03-29T02:00:00.000Z"), "closed")
  assert.equal(statusAt(maltaSunday, "2026-10-25T00:30:00.000Z"), "open")
  assert.equal(statusAt(maltaSunday, "2026-10-25T01:30:00.000Z"), "open")
  assert.equal(statusAt(maltaSunday, "2026-10-25T03:00:00.000Z"), "closed")
})

test("legacy boolean consumers retain their narrow missing-hours fallback", () => {
  const missingSchedule = isBusinessOpen({ timezone: "UTC" }, "2026-10-12T12:00:00.000Z")
  assert.equal(missingSchedule.isOpen, true)
  assert.equal(missingSchedule.status, "unknown")

  const malformedSchedule = isBusinessOpen(
    business({ operatingHours: weeklySchedule(undefined, { Monday: { closeTime: "25:00" } }) }),
    "2026-10-12T12:00:00.000Z",
  )
  assert.equal(malformedSchedule.isOpen, false)
  assert.equal(malformedSchedule.status, "unknown")

  const closedSchedule = isBusinessOpen(
    business({ operatingHours: weeklySchedule({ enabled: false, openTime: "09:00", closeTime: "17:00" }) }),
    "2026-10-12T12:00:00.000Z",
  )
  assert.equal(closedSchedule.isOpen, false)
  assert.equal(closedSchedule.status, "closed")
})
