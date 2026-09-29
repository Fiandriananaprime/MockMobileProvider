import { ProviderHttpError } from "../../shared/errors.js";

/** OFFICIAL (Orange Money WebPay): status values. */
export type OrangeStatus = "INITIATED" | "PENDING" | "EXPIRED" | "SUCCESS" | "FAILED";

/** OFFICIAL (WebPay): POST /webpayment body. */
export interface OrangeWebPaymentRequest {
  merchant_key: string;
  currency: string; // "OUV" on the sandbox; production Madagascar value: see README (assumption)
  order_id: string;
  amount: number;
  return_url: string;
  cancel_url: string;
  notif_url: string;
  lang?: string;
  reference?: string;
}

export interface OrangeTransaction {
  payToken: string;
  notifToken: string;
  request: OrangeWebPaymentRequest;
  amount: number;
  status: OrangeStatus;
  txnid?: string;
  profileType: string | null; // MOCK-ONLY: which fake profile paid on the hosted page
  createdAt: number;
  expiresAt: number;
}

/** OFFICIAL (observed): Orange gateway errors look like { code, message, description }. */
export const orangeError = (statusCode: number, code: number, message: string, description: string) =>
  new ProviderHttpError(statusCode, { code, message, description });

/** OFFICIAL pattern (code 23 "Missing body field"); the struct name in `description` is an ASSUMPTION. */
export const orangeMissingField = (struct: string, field: string) =>
  orangeError(
    400,
    23,
    "Missing body field",
    `Key: '${struct}.${field}' Error:Field validation for '${field}' failed on the 'required' tag`,
  );

/** ASSUMPTION: code/wording for an invalid or expired bearer token. */
export const orangeInvalidToken = () =>
  orangeError(401, 41, "Invalid token", "Invalid or expired access token (mock convention)");
