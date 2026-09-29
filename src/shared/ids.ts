import { randomBytes, randomInt, randomUUID } from "node:crypto";

export const uuid = (): string => randomUUID();

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Numeric-looking reference, like MVola's transactionReference (e.g. "641235"). */
export const numericReference = (digits = 9): string => {
  let out = String(randomInt(1, 10));
  while (out.length < digits) out += String(randomInt(0, 10));
  return out;
};

/** Orange-style transaction id, e.g. "MP260927.0039.A61409". */
export const orangeTxnId = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const suffix = randomHex(3).slice(0, 5).toUpperCase();
  return `MP${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}.${suffix}`;
};
