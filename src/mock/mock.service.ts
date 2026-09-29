export const SCENARIOS = ["success", "insufficient_balance", "account_not_found", "account_blocked", "provider_error", "timeout", "always_pending"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const PAYMENT_SUCCESS_RATE = 0.9;
export const paymentSucceeds = (): boolean => Math.random() < PAYMENT_SUCCESS_RATE;

export interface MockConfig {
  scenario: Scenario;
  /** Delay before a pending payment settles. */
  settleDelayMs: number;
  /** How long the "timeout" scenario hangs before answering 504. */
  timeoutMs: number;
}

const DEFAULTS: MockConfig = { scenario: "success", settleDelayMs: 1000, timeoutMs: 30_000 };
let config: MockConfig = { ...DEFAULTS };

export const getConfig = (): MockConfig => config;
export function configureMock(options: Partial<MockConfig>): MockConfig {
  const next = { ...config, ...options };
  if (!SCENARIOS.includes(next.scenario)) throw new Error(`scenario must be one of ${SCENARIOS.join(", ")}`);
  for (const [name, value] of [["settleDelayMs", next.settleDelayMs], ["timeoutMs", next.timeoutMs]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be an integer >= 0`);
  }
  config = next;
  return config;
}
