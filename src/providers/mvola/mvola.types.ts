import { ProviderHttpError } from "../../shared/errors";

export type KeyValue = { key: string; value: string };

/** OFFICIAL (MVola Merchant Pay v1): POST body of "Initiate Transaction". */
export interface MvolaInitiateRequest {
  amount: string;
  currency: string; // "Ar"
  descriptionText: string;
  requestingOrganisationTransactionReference: string;
  requestDate: string;
  originalTransactionReference?: string;
  debitParty: KeyValue[]; // [{ key: "msisdn", value: customerNumber }]
  creditParty: KeyValue[]; // [{ key: "msisdn", value: merchantNumber }]
  metadata?: KeyValue[]; // partnerName, fc, amountFc
}

export type MvolaStatus = "pending" | "completed" | "failed";

export interface MvolaTransaction {
  serverCorrelationId: string;
  xCorrelationId: string;
  /** Set when the transaction settles (completed OR failed). Empty until then. */
  transactionReference?: string;
  status: MvolaStatus;
  notificationMethod: "callback" | "polling";
  callbackUrl?: string;
  request: MvolaInitiateRequest;
  amount: number;
  debitMsisdn: string;
  creditMsisdn: string;
  profileType: string | null; // mock-internal: which fake profile paid
  createDate: string;
  fee: string;
  resultCode: string; // mock-internal, exposed as metadata/originalTransactionResult
  resultDesc: string;
}

export interface MvolaTokenResponse {
  access_token: string;
  scope: string;
  token_type: "Bearer";
  expires_in: number;
}

/**
 * ASSUMPTION: GSMA-style camelCase error object (errorCategory, errorCode, errorDescription,
 * errorDateTime, errorParameters). The MVola PDF lists the same fields with capitalised names.
 * Flip the casing here (only place) if your real integration shows otherwise.
 */
export const mvolaError = (
  statusCode: number,
  errorCategory: string,
  errorCode: string,
  errorDescription: string,
  errorParameters: KeyValue[] = [],
): ProviderHttpError =>
  new ProviderHttpError(statusCode, {
    errorCategory,
    errorCode,
    errorDescription,
    errorDateTime: new Date().toISOString(),
    errorParameters,
  });

/** OFFICIAL: invalid / missing access token response documented in the MVola PDF. */
export const mvolaInvalidCredentials = (): ProviderHttpError =>
  new ProviderHttpError(401, {
    fault: {
      code: 900901,
      message: "Invalid Credentials",
      description: "Invalid Credentials. Make sure you have given the correct access token",
    },
  });
