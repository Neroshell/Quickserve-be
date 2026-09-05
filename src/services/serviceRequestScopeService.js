function clean(value) {
  return String(value || "").trim()
}

export function buildActiveServiceRequestLocationScope({
  servicePointId,
}) {
  const canonicalServicePointId = clean(servicePointId)
  return canonicalServicePointId
    ? { servicePointId: canonicalServicePointId }
    : null
}

export function buildActiveServiceRequestScopeKey({
  businessId,
  module,
  servicePointId,
}) {
  const tenant = clean(businessId)
  const requestModule = clean(module)
  const canonicalServicePointId = clean(servicePointId)
  if (!tenant || !requestModule || !canonicalServicePointId) return null
  return JSON.stringify([tenant, requestModule, canonicalServicePointId])
}

export function getTrustedTableServicePointId(resolvedCallIdentity) {
  if (resolvedCallIdentity?.contextType !== "table_session") return null
  return clean(resolvedCallIdentity.servicePointId) || null
}
