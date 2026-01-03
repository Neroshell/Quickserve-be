import crypto from "crypto"

function pad2(n) {
  return String(n).padStart(2, "0")
}

function ddmmyy(date = new Date()) {
  const dd = pad2(date.getDate())
  const mm = pad2(date.getMonth() + 1)
  const yy = String(date.getFullYear()).slice(2)
  return `${dd}${mm}${yy}`
}

function hhmmss(date = new Date()) {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function rand4() {
  const num = crypto.randomInt(0, 10000)
  return String(num).padStart(4, "0")
}

export function generateOrderId(tableNumber, now = new Date()) {
  return `QS-${ddmmyy(now)}-T${tableNumber}-${hhmmss(now)}-${rand4()}`
}
