import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const encryptedMarker = "__pcc_encrypted";
const secretKeys = new Set([
  "password",
  "credential",
  "uuid",
  "privateKey",
  "private_key",
  "preSharedKey",
  "pre_shared_key",
  "token",
  "subscriptionUrl",
  "url",
  "content",
  "shareTokenHash"
]);

export function encryptionKeyFingerprint() {
  return `sha256:${createHash("sha256").update(config.configEncryptionKey).digest("hex").slice(0, 16)}`;
}

export function protectNodeConfig(input: Record<string, unknown>) {
  return protectObject(input, false) as Record<string, unknown>;
}

export function unprotectNodeConfig(input: Record<string, unknown>) {
  return unprotectObject(input) as Record<string, unknown>;
}

export function protectOptionalSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  return JSON.stringify(encryptString(value));
}

export function unprotectOptionalSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return decryptString(value);
}

function protectObject(value: unknown, forceSecret: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return forceSecret ? encryptString(value) : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => protectObject(item, forceSecret));
  if (isEncryptedPayload(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = forceSecret || secretKeys.has(key);
    output[key] = protectObject(child, sensitive);
  }
  return output;
}

function unprotectObject(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(unprotectObject);
  if (isEncryptedPayload(value)) return decryptPayload(value);

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = unprotectObject(child);
  }
  return output;
}

function encryptString(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    [encryptedMarker]: true,
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    value: ciphertext.toString("base64url")
  };
}

function decryptString(value: string): string {
  if (!looksLikeJsonPayload(value)) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isEncryptedPayload(parsed)) return value;
    const decrypted = decryptPayload(parsed);
    return typeof decrypted === "string" ? decrypted : value;
  } catch {
    return value;
  }
}

function decryptPayload(payload: unknown) {
  if (!isEncryptedPayload(payload)) return payload;
  const data = payload as Record<string, unknown>;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(String(data.iv), "base64url"));
  decipher.setAuthTag(Buffer.from(String(data.tag), "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(String(data.value), "base64url")), decipher.final()]);
  return plaintext.toString("utf8");
}

function encryptionKey() {
  return createHash("sha256").update(config.configEncryptionKey).digest();
}

function isEncryptedPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>)[encryptedMarker] === true &&
      (value as Record<string, unknown>).alg === "aes-256-gcm"
  );
}

function looksLikeJsonPayload(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.includes(encryptedMarker);
}
