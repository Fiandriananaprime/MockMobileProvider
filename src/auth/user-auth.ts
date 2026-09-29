import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getAccountById, type AccountRecord } from "../db.js";
import { ApiError } from "../shared/errors.js";
import { parseAuthorizationHeader } from "../shared/secrets.js";

const TOKEN_ISSUER = "mock-mobile-provider";
const TOKEN_AUDIENCE = "mock-mobile-user";
const SCRYPT_COST = 16_384;

const derivePasswordKey = (password: string, salt: string, length: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { N: SCRYPT_COST, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });

const secretKey = (): Uint8Array => {
  const secret = process.env.USER_AUTH_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw new ApiError(500, "CONFIGURATION_ERROR", "USER_AUTH_SECRET must contain at least 32 bytes");
  return new TextEncoder().encode(secret);
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = await derivePasswordKey(password, salt, 64);
  return `scrypt$${SCRYPT_COST}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [algorithm, cost, salt, encodedHash] = passwordHash.split("$");
  if (algorithm !== "scrypt" || cost !== String(SCRYPT_COST) || !salt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = await derivePasswordKey(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createUserAccessToken(accountId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(accountId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secretKey());
}

export async function verifyUserAccessToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE });
    if (!payload.sub) throw new Error("Missing subject");
    return payload.sub;
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "A valid user access token is required");
  }
}

export async function requireUserAccount(authorization: string | undefined): Promise<AccountRecord> {
  const token = parseAuthorizationHeader(authorization, "Bearer");
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "A valid user access token is required");
  const accountId = await verifyUserAccessToken(token);
  const account = await getAccountById(accountId);
  if (!account) throw new ApiError(401, "UNAUTHORIZED", "User account no longer exists");
  if (account.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_BLOCKED", "Account is blocked");
  return account;
}

export const validatePassword = (password: unknown): password is string =>
  typeof password === "string" && password.length >= 8 && password.length <= 128;