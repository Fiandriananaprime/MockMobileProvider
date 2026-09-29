import { MockError } from "../shared/errors.js";
import { clearMvolaTransactions } from "../providers/mvola/mvola.store.js";
import { clearOrangeTransactions } from "../providers/orange-money/orange.store.js";
import { getProfile, resetAllProfiles, resetProfile } from "./profiles.js";

export const SCENARIOS = ["success", "insufficient_balance", "provider_error", "timeout", "always_pending"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const PAYMENT_SUCCESS_RATE = 0.9;
export const paymentSucceeds = (): boolean => Math.random() < PAYMENT_SUCCESS_RATE;

export interface MockConfig {
  scenario: Scenario;
  /** Delay before a pending payment settles. */
  settleDelayMs: number;
  /** How long the "timeout" scenario hangs before answering 504. */
  timeoutMs: number;
  /** Orange only: if set, WebPay payments are auto-confirmed with this profile (no hosted page). */
  orangeAutoProfile: string | null;
}

const DEFAULTS: MockConfig = { scenario: "success", settleDelayMs: 1000, timeoutMs: 30_000, orangeAutoProfile: null };
let config: MockConfig = { ...DEFAULTS };

export const getConfig = (): MockConfig => config;
export const restoreDefaultConfig = (): MockConfig => (config = { ...DEFAULTS });

export function updateConfig(input: unknown): MockConfig {
  if (!input || typeof input !== "object") throw new MockError(400, "Body must be a JSON object");
  const b = input as Record<string, unknown>;
  const next = { ...config };

  if (b.scenario !== undefined) {
    if (!SCENARIOS.includes(b.scenario as Scenario)) throw new MockError(400, `scenario must be one of ${SCENARIOS.join(", ")}`);
    next.scenario = b.scenario as Scenario;
  }
  for (const f of ["settleDelayMs", "timeoutMs"] as const) {
    if (b[f] !== undefined) {
      if (typeof b[f] !== "number" || !Number.isInteger(b[f]) || (b[f] as number) < 0) throw new MockError(400, `${f} must be an integer >= 0`);
      next[f] = b[f] as number;
    }
  }
  if (b.orangeAutoProfile !== undefined) {
    if (b.orangeAutoProfile !== null) {
      const p = typeof b.orangeAutoProfile === "string" ? getProfile(b.orangeAutoProfile) : undefined;
      if (!p || p.provider !== "ORANGE_MONEY") throw new MockError(400, "orangeAutoProfile must be null or an ORANGE_MONEY_* profile");
    }
    next.orangeAutoProfile = b.orangeAutoProfile as string | null;
  }
  return (config = next);
}

export function resetOne(type: string) {
  const p = resetProfile(type);
  if (!p) throw new MockError(404, `Unknown profile ${type}`);
  return p;
}

export function resetEverything(opts: { transactions?: boolean; config?: boolean }) {
  const profiles = resetAllProfiles();
  if (opts.transactions) {
    clearMvolaTransactions();
    clearOrangeTransactions();
  }
  if (opts.config) restoreDefaultConfig();
  return profiles;
}
