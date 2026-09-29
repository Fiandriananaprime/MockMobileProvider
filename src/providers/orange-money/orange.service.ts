import type { IncomingHttpHeaders } from "node:http";
import { MockError, ProviderHttpError } from "../../shared/errors.js";
import { orangeTxnId, randomHex } from "../../shared/ids.js";
import { isCallbackUrlAllowed } from "../../shared/callback-url.js";
import { constantTimeEqual } from "../../shared/secrets.js";
import { getConfig, paymentSucceeds } from "../../mock/mock.service.js";
import { debitProfile, getProfile } from "../../mock/profiles.js";
import { orangeByNotifToken, orangeByPayToken, orangePayTokenByOrderId, orangeTokens } from "./orange.store.js";
import {
  OrangeTransaction,
  OrangeWebPaymentRequest,
  orangeError,
  orangeInvalidToken,
  orangeMissingField,
} from "./orange.types.js";

/** Path segment after /orange-money-webpay/: "dev" (sandbox, documented). "mg" = ASSUMPTION for Madagascar production. */
export const SUPPORTED_COUNTRY_SEGMENTS = ["dev", "mg"];
export const TOKEN_TTL_SECONDS = 7_776_000; // value seen in SDK docs (90 days)
const PAY_TOKEN_VALIDITY_MS = 10 * 60 * 1000; // OFFICIAL: default pay_token validity is 10 minutes
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const publicBaseUrl = (): string => {
  const baseUrl = process.env.PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 4010}`);
  return baseUrl.replace(/\/+$/, "");
};

/* ------------------------------------------------------------------ auth */

/**
 * POST /oauth/v3/token  (Authorization: Basic <authorization header>, body grant_type=client_credentials).
 * MOCK: any non-empty Basic value is accepted. Error body on bad credentials is an ASSUMPTION.
 */
export function handleTokenRequest(headers: IncomingHttpHeaders, body: unknown) {
  const auth = String(headers.authorization ?? "");
  const expectedAuth = process.env.NODE_ENV === "production" ? process.env.ORANGE_BASIC_AUTH ?? "" : undefined;
  const validCredentials = expectedAuth === undefined
    ? auth.startsWith("Basic ") && auth.length >= 8
    : Boolean(expectedAuth) && constantTimeEqual(auth, expectedAuth);
  if (!validCredentials) {
    throw new ProviderHttpError(401, {
      error: "invalid_client",
      error_description: "The requested client is not authorized (mock convention)",
    });
  }
  if (((body ?? {}) as Record<string, string>).grant_type !== "client_credentials") {
    throw new ProviderHttpError(400, {
      error: "unsupported_grant_type",
      error_description: "grant_type must be client_credentials",
    });
  }
  const token = randomHex(24);
  orangeTokens.set(token, Date.now() + TOKEN_TTL_SECONDS * 1000);
  // OFFICIAL shape (SDK docs): token_type, access_token, expires_in (string).
  return { token_type: "Bearer", access_token: token, expires_in: String(TOKEN_TTL_SECONDS) };
}

function checkBearer(headers: IncomingHttpHeaders): void {
  const auth = String(headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const expiry = orangeTokens.get(token);
  if (!token || !expiry || expiry < Date.now()) throw orangeInvalidToken();
}

/* ------------------------------------------------------------ operations */

const asAmount = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/** OFFICIAL: POST /webpayment -> 201 { status, message, pay_token, payment_url, notif_token } */
export async function createWebPayment(headers: IncomingHttpHeaders, body: unknown) {
  checkBearer(headers);
  const b = (body ?? {}) as Record<string, unknown>;
  const STRUCT = "WebPaymentInfo"; // ASSUMPTION (only affects error text)
  for (const f of ["merchant_key", "currency", "order_id", "return_url", "cancel_url", "notif_url"]) {
    if (typeof b[f] !== "string" || !(b[f] as string).trim()) throw orangeMissingField(STRUCT, f);
  }
  if (!isCallbackUrlAllowed(b.notif_url as string)) {
    throw orangeError(400, 23, "Invalid callback URL", "notif_url must be HTTP(S), and HTTPS with an allowed host in production");
  }
  const amount = asAmount(b.amount);
  if (amount === null) throw orangeMissingField(STRUCT, "amount");

  const cfg = getConfig();
  if (cfg.scenario === "timeout") {
    await sleep(cfg.timeoutMs);
    throw orangeError(504, 504, "Gateway Timeout", "Mock scenario: timeout");
  }
  if (cfg.scenario === "provider_error") {
    throw orangeError(500, 500, "Internal Server Error", "Mock scenario: provider_error");
  }

  const tx: OrangeTransaction = {
    payToken: randomHex(32),
    notifToken: randomHex(16),
    request: b as unknown as OrangeWebPaymentRequest,
    amount,
    status: "INITIATED",
    profileType: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + PAY_TOKEN_VALIDITY_MS,
  };
  orangeByPayToken.set(tx.payToken, tx);
  orangeByNotifToken.set(tx.notifToken, tx);
  orangePayTokenByOrderId.set(tx.request.order_id, tx.payToken);

  // MOCK-ONLY convenience: skip the hosted page and pay with a preset profile.
  if (cfg.orangeAutoProfile) confirmPayment(tx.payToken, cfg.orangeAutoProfile);

  return {
    status: 201,
    message: "OK",
    pay_token: tx.payToken,
    // MOCK-ONLY page standing in for Orange's hosted payment page.
    payment_url: `${publicBaseUrl()}/__mock/orange/pay/${tx.payToken}`,
    notif_token: tx.notifToken,
  };
}

const refreshExpiry = (tx: OrangeTransaction): void => {
  if (tx.status === "INITIATED" && Date.now() > tx.expiresAt) tx.status = "EXPIRED";
};

/** OFFICIAL: POST /transactionstatus { order_id, amount, pay_token } -> { status, order_id, txnid } */
export function getTransactionStatus(headers: IncomingHttpHeaders, body: unknown) {
  checkBearer(headers);
  const b = (body ?? {}) as Record<string, unknown>;
  const STRUCT = "GetTransactionStatusInfo"; // seen in a real Orange error message
  if (typeof b.order_id !== "string" || !b.order_id) throw orangeMissingField(STRUCT, "OrderId");
  if (typeof b.pay_token !== "string" || !b.pay_token) throw orangeMissingField(STRUCT, "PayToken");
  const amount = asAmount(b.amount);
  if (amount === null) throw orangeMissingField(STRUCT, "Amount");

  // ASSUMPTION: unknown / mismatching transaction -> 404 with an Orange-style body.
  const tx = orangeByPayToken.get(b.pay_token);
  if (!tx || tx.request.order_id !== b.order_id || tx.amount !== amount) {
    throw orangeError(404, 60, "Transaction not found", "No transaction matches order_id, amount and pay_token (mock convention)");
  }
  refreshExpiry(tx);
  const res: Record<string, unknown> = { status: tx.status, order_id: tx.request.order_id };
  if (tx.txnid) res.txnid = tx.txnid;
  return res;
}

/* ------------------------------------------------- MOCK-ONLY: customer step */

/** Simulates the customer choosing a fake wallet on the hosted page and pressing "Confirm". */
export function confirmPayment(payToken: string, profileType: string): OrangeTransaction {
  const tx = orangeByPayToken.get(payToken);
  if (!tx) throw new MockError(404, "Unknown pay_token");
  const profile = getProfile(profileType);
  if (!profile || profile.provider !== "ORANGE_MONEY") {
    throw new MockError(400, `${profileType} is not an ORANGE_MONEY profile`);
  }
  refreshExpiry(tx);
  if (tx.status !== "INITIATED") throw new MockError(409, `Transaction is ${tx.status}, cannot confirm`);

  tx.profileType = profile.type;
  tx.status = "PENDING"; // OFFICIAL: user clicked "Confirmer"
  const cfg = getConfig();
  if (cfg.scenario !== "always_pending") setTimeout(() => void settle(tx), cfg.settleDelayMs).unref();
  return tx;
}

async function settle(tx: OrangeTransaction): Promise<void> {
  const cfg = getConfig();
  const profile = tx.profileType ? getProfile(tx.profileType) : undefined;
  if (profile && cfg.scenario !== "insufficient_balance" && tx.amount <= profile.balance && paymentSucceeds()) {
    debitProfile(profile.type, tx.amount);
    tx.status = "SUCCESS";
    tx.txnid = orangeTxnId();
  } else {
    tx.status = "FAILED";
  }
  // OFFICIAL (observed): Orange POSTs { status, notif_token, txnid } to notif_url.
  try {
    await fetch(tx.request.notif_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: tx.status, notif_token: tx.notifToken, txnid: tx.txnid }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[orange] notification to ${tx.request.notif_url} failed:`, (err as Error).message);
  }
}
