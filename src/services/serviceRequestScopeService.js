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

export function getTrustedTableServicePointId(resolvedCallIdentity) {
  if (resolvedCallIdentity?.contextType !== "table_session") return null
  return clean(resolvedCallIdentity.servicePointId) || null
}
