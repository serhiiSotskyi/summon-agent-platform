import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { requireEnv } from "@/lib/env";

const ENCRYPTION_VERSION = "v1";

function getEncryptionKey() {
  const rawKey = requireEnv("CONNECTOR_ENCRYPTION_KEY").trim();

  if (/^[a-f0-9]{64}$/i.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }

  const base64Key = Buffer.from(rawKey, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  if (Buffer.byteLength(rawKey) >= 32) {
    return createHash("sha256").update(rawKey).digest();
  }

  throw new Error(
    "CONNECTOR_ENCRYPTION_KEY must be a 32-byte base64 value, 64-character hex value, or at least 32 characters.",
  );
}

export function encryptConnectorCredentials(payload: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptConnectorCredentials<T = unknown>(value: string): T {
  const [version, rawIv, rawAuthTag, rawCiphertext] = value.split(":");
  if (
    version !== ENCRYPTION_VERSION ||
    !rawIv ||
    !rawAuthTag ||
    !rawCiphertext
  ) {
    throw new Error("Unsupported connector credential payload.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(rawIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(rawAuthTag, "base64url"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext) as T;
}
