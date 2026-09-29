import type { MvolaTransaction } from "./mvola.types";

/** All state is in memory and lost on restart. */
export const mvolaTokens = new Map<string, number>(); // token -> expiry (epoch ms)
export const mvolaByServerCorrelationId = new Map<string, MvolaTransaction>();
export const mvolaByTransactionReference = new Map<string, MvolaTransaction>();
/** X-CorrelationID (client request id) -> serverCorrelationId */
export const mvolaByXCorrelationId = new Map<string, string>();
/** requestingOrganisationTransactionReference -> serverCorrelationId (duplicate detection) */
export const mvolaByPartnerReference = new Map<string, string>();

export const clearMvolaTransactions = (): void => {
  mvolaByServerCorrelationId.clear();
  mvolaByTransactionReference.clear();
  mvolaByXCorrelationId.clear();
  mvolaByPartnerReference.clear();
};
