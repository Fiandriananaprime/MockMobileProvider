import type { OrangeTransaction } from "./orange.types.js";

/** All state is in memory and lost on restart. */
export const orangeTokens = new Map<string, number>(); // access_token -> expiry (epoch ms)
export const orangeByPayToken = new Map<string, OrangeTransaction>();
export const orangeByNotifToken = new Map<string, OrangeTransaction>();
/** order_id -> pay_token (latest one wins) */
export const orangePayTokenByOrderId = new Map<string, string>();

export const clearOrangeTransactions = (): void => {
  orangeByPayToken.clear();
  orangeByNotifToken.clear();
  orangePayTokenByOrderId.clear();
};
