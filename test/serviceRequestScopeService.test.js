import assert from "node:assert/strict"
import test from "node:test"

import {
  buildActiveServiceRequestLocationScope,
  getTrustedTableServicePointId,
} from "../src/services/serviceRequestScopeService.js"

test("active waiter-call lookup prefers canonical servicePointId", () => {
  assert.deepEqual(
    buildActiveServiceRequestLocationScope({
      servicePointId: "sp-1",
    }),
    { servicePointId: "sp-1" },
  )
})

test("active waiter-call lookup never falls back to a display label", () => {
  assert.equal(
    buildActiveServiceRequestLocationScope({ servicePointId: null }),
    null,
  )
})

test("only a trusted table session supplies customer list scope", () => {
  assert.equal(
    getTrustedTableServicePointId({
      contextType: "table_session",
      servicePointId: "sp-1",
    }),
    "sp-1",
  )
  assert.equal(
    getTrustedTableServicePointId({
      contextType: "public",
      servicePointId: "sp-1",
    }),
    null,
  )
})
