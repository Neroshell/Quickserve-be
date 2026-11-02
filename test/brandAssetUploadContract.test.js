import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../src/routes/upload-route.js", import.meta.url), "utf8")

test("brand asset contract persists distinct logo and cover fields", () => {
  assert.match(source, /router\.post\("\/brand-asset", requireManagementArea\(MANAGEMENT_ACCESS_AREAS\.BRANDING\)/)
  assert.match(source, /assetType must be logo or cover/)
  assert.match(source, /assetType === "logo" \? "logoUrl" : "coverImageUrl"/)
  assert.match(source, /if \(assetType === "logo"\) \{\s*business\.logoUrl = secure_url/)
})

test("brand asset contract validates image bytes and persists before cleanup", () => {
  assert.match(source, /Image content does not match an allowed JPEG, PNG, or WebP file/)
  assert.match(source, /await business\.save\(\)/)
  assert.match(source, /deleteFromCloudinary\(previousLogoPublicId\)/)
})
