import type { IncomingHttpHeaders } from "node:http";
import { ProviderHttpError } from "../../shared/errors.js";
import { numericReference, randomHex, uuid } from "../../shared/ids.js";
import { isCallbackUrlAllowed } from "../../shared/callback-url.js";
import { constantTimeEqual } from "../../shared/secrets.js";
import { getConfig, paymentSucceeds } from "../../mock/mock.service.js";
import { debitProfile, findProfileByMsisdn } from "../../mock/profiles.js";
import {
  mvolaByPartnerReference,
  mvolaByServerCorrelationId,
  mvolaByTransactionReference,
  mvolaByXCorrelationId,
  mvolaTokens,
} from "./mvola.store.js";
import {
  KeyValue,
  MvolaInitiateRequest,
  MvolaTokenResponse,
  MvolaTransaction,
  mvolaError,
  mvolaInvalidCredentials,
} from "./mvola.types.js";

export const TOKEN_TTL_SECONDS = 3600;
export const SUPPORTED_PATH_VERSIONS = ["1.0.0", "1.0"]; // the PDF shows both spellings
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ auth */

/**
 * POST /token  (client_credentials, Basic auth key:secret, scope EXT_INT_MVOLA_SCOPE).
 * MOCK: any non-empty Basic credentials are accepted; no real OAuth server is contacted.
 * ASSUMPTION: the error body format on bad credentials (WSO2-style OAuth error).
 */
export function handleTokenRequest(headers: IncomingHttpHeaders, body: unknown): MvolaTokenResponse {
  const auth = String(headers.authorization ?? "");
  const decoded = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
  const productionCredentials = process.env.NODE_ENV === "production"
    ? `${process.env.MVOLA_CLIENT_KEY ?? ""}:${process.env.MVOLA_CLIENT_SECRET ?? ""}`
    : undefined;
  const validCredentials = productionCredentials === undefined
    ? decoded.includes(":") && decoded.length >= 3
    : Boolean(process.env.MVOLA_CLIENT_KEY && process.env.MVOLA_CLIENT_SECRET) && constantTimeEqual(decoded, productionCredentials);
  if (!validCredentials) {
    throw new ProviderHttpError(401, {
      error: "invalid_client",
      error_description: "Client authentication failed (send Authorization: Basic base64(key:secret))",
    });
  }
  const form = (body ?? {}) as Record<string, string>;
  if (form.grant_type !== "client_credentials") {
    throw new ProviderHttpError(400, {
      error: "unsupported_grant_type",
      error_description: "grant_type must be client_credentials",
    });
  }
  const token = randomHex(24);
  mvolaTokens.set(token, Date.now() + TOKEN_TTL_SECONDS * 1000);
  return {
    access_token: token,
    scope: form.scope || "EXT_INT_MVOLA_SCOPE",
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
  };
}

function checkBearer(headers: IncomingHttpHeaders): void {
  const auth = String(headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const expiry = mvolaTokens.get(token);
  if (!token || !expiry || expiry < Date.now()) throw mvolaInvalidCredentials();
}

/* --------------------------------------------------------------- headers */

interface RequestContext {
  xCorrelationId: string;
  userLanguage: "FR" | "MG";
  merchantMsisdn: string;
  partnerName: string;
  callbackUrl?: string;
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.trim()) {
    throw mvolaError(400, "validation", "formatError", `Missing required header: ${name}`, [
      { key: name, value: "required" },
    ]);
  }
  return value.trim();
}

/** OFFICIAL headers: Authorization, Version, X-CorrelationID, UserLanguage, UserAccountIdentifier, partnerName. */
function checkContractHeaders(headers: IncomingHttpHeaders): RequestContext {
  checkBearer(headers);

  const version = header(headers, "Version");
  if (!["1", "1.0", "1.0.0"].includes(version)) {
    throw mvolaError(400, "validation", "formatError", "Unsupported Version header", [
      { key: "Version", value: version },
    ]);
  }
  const xCorrelationId = header(headers, "X-CorrelationID");
  if (xCorrelationId.length > 40 || !UUID_RE.test(xCorrelationId)) {
    throw mvolaError(400, "validation", "formatError", "X-CorrelationID must be a UUID (max 40 chars)", [
      { key: "X-CorrelationID", value: xCorrelationId },
    ]);
  }
  const lang = header(headers, "UserLanguage").toUpperCase();
  if (lang !== "FR" && lang !== "MG") {
    throw mvolaError(400, "validation", "formatError", "UserLanguage must be FR or MG", [
      { key: "UserLanguage", value: lang },
    ]);
  }
  const uai = header(headers, "UserAccountIdentifier");
  const m = /^msisdn;(\S+)$/i.exec(uai);
  if (!m) {
    throw mvolaError(400, "validation", "formatError", "UserAccountIdentifier must be msisdn;<merchantNumber>", [
      { key: "UserAccountIdentifier", value: uai },
    ]);
  }
  const partnerName = header(headers, "partnerName");
  // Callback URL header: used by the community SDKs ("X-Callback-URL"); optional.
  const cb = headers["x-callback-url"];
  const callbackUrl = (Array.isArray(cb) ? cb[0] : cb)?.trim() || undefined;
  if (callbackUrl && !isCallbackUrlAllowed(callbackUrl)) {
    throw mvolaError(400, "validation", "formatError", "X-Callback-URL is not an allowed callback URL", [
      { key: "X-Callback-URL", value: "must be HTTP(S), and HTTPS with an allowed host in production" },
    ]);
  }

  return { xCorrelationId, userLanguage: lang, merchantMsisdn: m[1], partnerName, callbackUrl };
}

/* ------------------------------------------------------------------ body */

const bad = (field: string, msg: string) =>
  mvolaError(400, "validation", "formatError", `Invalid JSON Field: ${field} ${msg}`, [
    { key: field, value: msg },
  ]);

const msisdnOf = (parties: KeyValue[], field: string): string => {
  if (!Array.isArray(parties) || parties.length === 0) throw bad(field, "is required");
  const p = parties.find((x) => x && String(x.key).toLowerCase() === "msisdn");
  if (!p || typeof p.value !== "string" || !p.value.trim()) throw bad(field, "must contain key msisdn");
  return p.value.trim();
};

function parseInitiateBody(body: unknown): { req: MvolaInitiateRequest; amount: number; debit: string; credit: string } {
  if (!body || typeof body !== "object") throw bad("body", "must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.amount !== "string" || !/^\d+(\.\d+)?$/.test(b.amount) || Number(b.amount) <= 0) {
    throw bad("amount", "must be a positive numeric string");
  }
  if (b.currency !== "Ar") throw bad("currency", 'must be "Ar"');
  for (const f of ["descriptionText", "requestingOrganisationTransactionReference", "requestDate"]) {
    if (typeof b[f] !== "string" || !(b[f] as string).trim()) throw bad(f, "is required");
  }
  const debit = msisdnOf(b.debitParty as KeyValue[], "debitParty");
  const credit = msisdnOf(b.creditParty as KeyValue[], "creditParty");
  return { req: b as unknown as MvolaInitiateRequest, amount: Number(b.amount), debit, credit };
}

/* ------------------------------------------------------------ operations */

export async function initiatePayment(headers: IncomingHttpHeaders, body: unknown) {
  const ctx = checkContractHeaders(headers);
  const { req, amount, debit, credit } = parseInitiateBody(body);
  const cfg = getConfig();

  // Mock scenarios (mock-only behaviour, provider contract unchanged)
  if (cfg.scenario === "timeout") {
    await sleep(cfg.timeoutMs);
    throw mvolaError(504, "internal", "genericError", "Gateway timeout (mock scenario: timeout)");
  }
  if (cfg.scenario === "provider_error") {
    throw mvolaError(503, "internal", "genericError", "The service is not currently available (mock scenario: provider_error)");
  }

  // ASSUMPTION: the PDF mentions 409 for conflicting/idempotent requests; we apply it to a reused partner reference.
  const ref = req.requestingOrganisationTransactionReference;
  if (mvolaByPartnerReference.has(ref)) {
    throw mvolaError(409, "businessRule", "duplicateRequest", "requestingOrganisationTransactionReference already used", [
      { key: "requestingOrganisationTransactionReference", value: ref },
    ]);
  }

  const tx: MvolaTransaction = {
    serverCorrelationId: uuid(),
    xCorrelationId: ctx.xCorrelationId,
    status: "pending",
    notificationMethod: ctx.callbackUrl ? "callback" : "polling",
    callbackUrl: ctx.callbackUrl,
    request: req,
    amount,
    debitMsisdn: debit,
    creditMsisdn: credit,
    profileType: null,
    createDate: new Date().toISOString(),
    fee: "0",
    resultCode: "",
    resultDesc: "",
  };
  mvolaByServerCorrelationId.set(tx.serverCorrelationId, tx);
  mvolaByXCorrelationId.set(tx.xCorrelationId, tx.serverCorrelationId);
  mvolaByPartnerReference.set(ref, tx.serverCorrelationId);

  if (cfg.scenario !== "always_pending") {
    setTimeout(() => void settle(tx), cfg.settleDelayMs).unref();
  }

  // OFFICIAL body: status (static "pending"), serverCorrelationId, notificationMethod.
  return { status: "pending" as const, serverCorrelationId: tx.serverCorrelationId, notificationMethod: tx.notificationMethod };
}

/**
 * Simulated outcome:
 *  - unknown debit MSISDN            -> failed
 *  - insufficient balance            -> failed
 *  - eligible payment                -> 90% completed, 10% failed
 * Result codes/descriptions are ASSUMPTIONS (MVola's result-code table is not public).
 */
async function settle(tx: MvolaTransaction): Promise<void> {
  const cfg = getConfig();
  const profile = findProfileByMsisdn("MVOLA", tx.debitMsisdn);
  let ok = false;
  if (!profile) {
    tx.resultCode = "1002";
    tx.resultDesc = "Debit account not found (mock)";
  } else if (cfg.scenario === "insufficient_balance" || tx.amount > profile.balance) {
    tx.profileType = profile.type;
    tx.resultCode = "1001";
    tx.resultDesc = "Insufficient funds";
  } else if (!paymentSucceeds()) {
    tx.profileType = profile.type;
    tx.resultCode = "1003";
    tx.resultDesc = "Payment declined (mock random failure)";
  } else {
    tx.profileType = profile.type;
    debitProfile(profile.type, tx.amount);
    ok = true;
    tx.resultCode = "0";
    tx.resultDesc = "Completed";
  }
  tx.status = ok ? "completed" : "failed";
  tx.transactionReference = numericReference(9);
  mvolaByTransactionReference.set(tx.transactionReference, tx);
  await sendCallback(tx);
}

/** OFFICIAL callback: PUT <callbackUrl> with transactionStatus, serverCorrelationId, transactionReference, ... */
async function sendCallback(tx: MvolaTransaction): Promise<void> {
  if (!tx.callbackUrl) return;
  const payload: Record<string, unknown> = {
    transactionStatus: tx.status,
    serverCorrelationId: tx.serverCorrelationId,
    transactionReference: tx.transactionReference,
    requestDate: tx.request.requestDate,
    debitParty: [{ key: "msisdn", value: tx.debitMsisdn }],
    creditParty: [{ key: "msisdn", value: tx.creditMsisdn }],
    metadata: tx.request.metadata ?? [],
  };
  if (tx.status === "completed") payload.fees = [{ feeAmount: tx.fee }];
  try {
    await fetch(tx.callbackUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[mvola] callback to ${tx.callbackUrl} failed:`, (err as Error).message);
  }
}

/** OFFICIAL: GET .../status/{serverCorrelationId} -> status, serverCorrelationId, notificationMethod, objectReference */
export function getTransactionStatus(headers: IncomingHttpHeaders, serverCorrelationId: string) {
  checkContractHeaders(headers);
  const tx = mvolaByServerCorrelationId.get(serverCorrelationId);
  if (!tx) throw mvolaError(404, "validation", "notFound", "Unknown serverCorrelationId", [{ key: "serverCorrelationId", value: serverCorrelationId }]);
  return {
    status: tx.status,
    serverCorrelationId: tx.serverCorrelationId,
    notificationMethod: tx.notificationMethod,
    objectReference: tx.transactionReference ?? "",
  };
}

/** OFFICIAL: GET .../{transID} (transID = objectReference from the status call). */
export function getTransactionDetails(headers: IncomingHttpHeaders, transId: string) {
  checkContractHeaders(headers);
  const tx = mvolaByTransactionReference.get(transId);
  if (!tx) throw mvolaError(404, "validation", "notFound", "Unknown transaction reference", [{ key: "transID", value: transId }]);
  return {
    amount: String(tx.amount),
    currency: "Ar",
    transactionReference: tx.transactionReference,
    transactionStatus: tx.status,
    createDate: tx.createDate,
    debitParty: [{ key: "msisdn", value: tx.debitMsisdn }],
    creditParty: [{ key: "msisdn", value: tx.creditMsisdn }],
    metadata: [
      { key: "originalTransactionResult", value: tx.resultCode },
      { key: "originalTransactionResultDesc", value: tx.resultDesc },
    ],
    fees: [{ feeAmount: tx.fee }],
  };
}
