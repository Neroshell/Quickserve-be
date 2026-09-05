import crypto from "node:crypto"

export function generateOrderLineId() {
  return `oln_${crypto.randomBytes(12).toString("hex")}`
}
