/**
 * The 10 predefined fake phone profiles. EDIT THIS ARRAY to change numbers / balances.
 *
 * These MSISDNs exist ONLY inside the mock. They are never the user's real phone number.
 * Many users may share one profile; balances are per PROFILE, not per user.
 */
export type Provider = "MVOLA" | "ORANGE_MONEY";

export type FakePhoneProfile = {
  type: string;
  provider: Provider;
  fakeMsisdn: string;
  initialBalance: number;
  balance: number;
};

const DEFINITIONS: ReadonlyArray<Omit<FakePhoneProfile, "balance">> = [
  { type: "MVOLA_1", provider: "MVOLA", fakeMsisdn: "03435000001", initialBalance: 1_000 },
  { type: "MVOLA_2", provider: "MVOLA", fakeMsisdn: "03435000002", initialBalance: 5_000 },
  { type: "MVOLA_3", provider: "MVOLA", fakeMsisdn: "03435000003", initialBalance: 10_000 },
  { type: "MVOLA_4", provider: "MVOLA", fakeMsisdn: "03435000004", initialBalance: 100_000 },
  { type: "MVOLA_5", provider: "MVOLA", fakeMsisdn: "03435000005", initialBalance: 1_000_000 },
  { type: "ORANGE_MONEY_1", provider: "ORANGE_MONEY", fakeMsisdn: "03200000001", initialBalance: 1_000 },
  { type: "ORANGE_MONEY_2", provider: "ORANGE_MONEY", fakeMsisdn: "03200000002", initialBalance: 5_000 },
  { type: "ORANGE_MONEY_3", provider: "ORANGE_MONEY", fakeMsisdn: "03200000003", initialBalance: 10_000 },
  { type: "ORANGE_MONEY_4", provider: "ORANGE_MONEY", fakeMsisdn: "03200000004", initialBalance: 100_000 },
  { type: "ORANGE_MONEY_5", provider: "ORANGE_MONEY", fakeMsisdn: "03200000005", initialBalance: 1_000_000 },
];

const state = new Map<string, FakePhoneProfile>(
  DEFINITIONS.map((d) => [d.type, { ...d, balance: d.initialBalance }]),
);

export const listProfiles = (): FakePhoneProfile[] => Array.from(state.values());

export const getProfile = (type: string): FakePhoneProfile | undefined => state.get(type);

export const findProfileByMsisdn = (provider: Provider, msisdn: string): FakePhoneProfile | undefined =>
  listProfiles().find((p) => p.provider === provider && p.fakeMsisdn === msisdn.replace(/\s+/g, ""));

/** Simulated payment: lowers the running balance only. initialBalance is never touched. */
export const debitProfile = (type: string, amount: number): void => {
  const p = state.get(type);
  if (p) p.balance -= amount;
};

export const resetProfile = (type: string): FakePhoneProfile | undefined => {
  const p = state.get(type);
  if (p) p.balance = p.initialBalance;
  return p;
};

export const resetAllProfiles = (): FakePhoneProfile[] => {
  state.forEach((p) => (p.balance = p.initialBalance));
  return listProfiles();
};
