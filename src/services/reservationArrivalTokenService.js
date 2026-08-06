import crypto from "node:crypto";

const TOKEN_PREFIX = "qsa1";
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_AAD = Buffer.from("quickserve:reservation-arrival:v1");

export class ReservationArrivalTokenConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReservationArrivalTokenConfigurationError";
    this.code = "RESERVATION_ARRIVAL_TOKEN_SECRET_MISSING";
  }
}

export function getReservationArrivalTokenSecret(env = process.env) {
  const value = String(
    env.RESERVATION_ARRIVAL_TOKEN_SECRET || env.SESSION_SECRET || "",
  );
  if (value.length < 32) {
    throw new ReservationArrivalTokenConfigurationError(
      "RESERVATION_ARRIVAL_TOKEN_SECRET must contain at least 32 characters",
    );
  }
  return value;
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedInstant(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return date.toISOString();
}

function arrivalTokenClaims(reservation) {
  const reservationId = String(reservation?._id || "").trim();
  const businessId = String(reservation?.businessId || "").trim();
  const email = normalizedEmail(reservation?.email);
  const version = String(reservation?.arrivalReminderVersion || "").trim();
  if (!reservationId || !businessId || !email || !version) {
    throw new TypeError("Arrival token scope is incomplete");
  }

  return {
    businessId,
    reservationId,
    guestHash: crypto.createHash("sha256").update(email).digest("hex"),
    version,
    expiresAt: normalizedInstant(
      reservation.arrivalTokenExpiresAt,
      "arrivalTokenExpiresAt",
    ),
  };
}

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

export function createReservationArrivalToken(
  reservation,
  { env = process.env } = {},
) {
  const secret = getReservationArrivalTokenSecret(env);
  const claims = arrivalTokenClaims(reservation);
  const plaintext = Buffer.from(JSON.stringify(claims));
  const iv = crypto
    .createHmac("sha256", secret)
    .update("reservation-arrival-iv\n")
    .update(plaintext)
    .digest()
    .subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(TOKEN_AAD);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_PREFIX,
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function hashReservationArrivalToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function isReservationArrivalTokenWellFormed(token) {
  const [prefix, iv, encrypted, tag, extra] = String(token || "").split(".");
  return prefix === TOKEN_PREFIX &&
    !extra &&
    iv?.length === 16 &&
    tag?.length === 22 &&
    TOKEN_PART_PATTERN.test(iv) &&
    TOKEN_PART_PATTERN.test(encrypted || "") &&
    TOKEN_PART_PATTERN.test(tag);
}

export function decodeReservationArrivalToken(
  token,
  { env = process.env } = {},
) {
  if (!isReservationArrivalTokenWellFormed(token)) return null;
  const secret = getReservationArrivalTokenSecret(env);
  const [, encodedIv, encodedPayload, encodedTag] = String(token).split(".");
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedPayload, "base64url")),
      decipher.final(),
    ]);
    const claims = JSON.parse(plaintext.toString("utf8"));
    if (
      typeof claims?.businessId !== "string" ||
      typeof claims?.reservationId !== "string" ||
      typeof claims?.guestHash !== "string" ||
      typeof claims?.version !== "string" ||
      !Number.isFinite(new Date(claims?.expiresAt).getTime())
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function reservationArrivalTokenMatches(
  token,
  reservation,
  { env = process.env } = {},
) {
  if (!isReservationArrivalTokenWellFormed(token)) return false;
  let expected;
  try {
    expected = createReservationArrivalToken(reservation, { env });
  } catch (error) {
    if (error?.code === "RESERVATION_ARRIVAL_TOKEN_SECRET_MISSING") throw error;
    return false;
  }
  const suppliedBuffer = Buffer.from(String(token));
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}
