import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { ProviderType, RuntimeConfig } from "./config.js";
import { ApiError } from "./shared/errors.js";

export type AccountStatus = "ACTIVE" | "BLOCKED";
export type LedgerType = "PAYMENT" | "TOPUP" | "RESET" | "REFUND";
export type LedgerStatus = "SUCCESS" | "FAILED";

export interface AccountRecord {
  id: string;
  provider: ProviderType;
  msisdn: string;
  passwordHash: string;
  balance: number;
  currency: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export type PublicAccountRecord = Omit<AccountRecord, "passwordHash">;

export interface TransactionRecord {
  id: string;
  accountId: string;
  provider: ProviderType;
  type: LedgerType;
  amount: number;
  currency: string;
  status: LedgerStatus;
  reference: string;
  balanceBefore: number;
  balanceAfter: number;
  createdAt: string;
}

interface PublicAccountRow extends QueryResultRow {
  id: string;
  provider: ProviderType;
  msisdn: string;
  balance: string | number;
  currency: string;
  status: AccountStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface AccountRow extends PublicAccountRow {
  passwordHash: string;
}

interface TransactionRow extends QueryResultRow {
  id: string;
  accountId: string;
  provider: ProviderType;
  type: LedgerType;
  amount: string | number;
  currency: string;
  status: LedgerStatus;
  reference: string;
  balanceBefore: string | number;
  balanceAfter: string | number;
  createdAt: Date | string;
}

const ACCOUNT_FIELDS = `id, provider, msisdn, password_hash AS "passwordHash", balance,
  currency, status, created_at AS "createdAt", updated_at AS "updatedAt"`;
const PUBLIC_ACCOUNT_FIELDS = `id, provider, msisdn, balance, currency, status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const TRANSACTION_FIELDS = `id, account_id AS "accountId", provider, type, amount, currency,
  status, reference, balance_before AS "balanceBefore", balance_after AS "balanceAfter",
  created_at AS "createdAt"`;
const JOINED_TRANSACTION_FIELDS = `t.id, t.account_id AS "accountId", t.provider, t.type, t.amount, t.currency,
  t.status, t.reference, t.balance_before AS "balanceBefore", t.balance_after AS "balanceAfter",
  t.created_at AS "createdAt"`;

let pool: Pool | undefined;
let initialization: Promise<void> | undefined;

export async function ensureDatabaseReady(config: RuntimeConfig): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      pool = new Pool({ connectionString: config.databaseUrl });
      const migrationPath = path.resolve(process.cwd(), "database", "migrations", "001_mock_user_accounts.sql");
      try {
        await pool.query(await readFile(migrationPath, "utf8"));
      } catch (error) {
        await pool.end();
        pool = undefined;
        initialization = undefined;
        throw error;
      }
    })();
  }
  await initialization;
}

export async function closeDatabase(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  initialization = undefined;
}

const database = (): Pool => {
  if (!pool) throw new Error("PostgreSQL has not been initialized");
  return pool;
};

const toAccount = (row: AccountRow): AccountRecord => ({
  ...row,
  balance: Number(row.balance),
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

const toPublicAccount = (row: PublicAccountRow): PublicAccountRecord => ({
  ...row,
  balance: Number(row.balance),
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

const toTransaction = (row: TransactionRow): TransactionRecord => ({
  ...row,
  amount: Number(row.amount),
  balanceBefore: Number(row.balanceBefore),
  balanceAfter: Number(row.balanceAfter),
  createdAt: new Date(row.createdAt).toISOString(),
});

export async function createAccount(
  provider: ProviderType,
  prefixes: string[],
  passwordHash: string,
): Promise<AccountRecord> {
  const pool = database();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const prefix = prefixes[randomInt(prefixes.length)];
    const msisdn = `${prefix}${randomInt(10_000_000).toString().padStart(7, "0")}`;
    const result = await pool.query<AccountRow>(
      `INSERT INTO mock_accounts (provider, msisdn, password_hash, balance, currency, status)
       VALUES ($1, $2, $3, 0, 'MGA', 'ACTIVE')
       ON CONFLICT (msisdn) DO NOTHING
       RETURNING ${ACCOUNT_FIELDS}`,
      [provider, msisdn, passwordHash],
    );
    if (result.rows[0]) return toAccount(result.rows[0]);
  }
  throw new ApiError(503, "MSISDN_ALLOCATION_FAILED", "Unable to allocate a unique phone number");
}

export async function getAccountByMsisdn(msisdn: string): Promise<AccountRecord | undefined> {
  const result = await database().query<AccountRow>(
    `SELECT ${ACCOUNT_FIELDS} FROM mock_accounts WHERE msisdn = $1`,
    [msisdn.replace(/\s+/g, "")],
  );
  return result.rows[0] ? toAccount(result.rows[0]) : undefined;
}

export async function getAccountById(id: string): Promise<AccountRecord | undefined> {
  const result = await database().query<AccountRow>(
    `SELECT ${ACCOUNT_FIELDS} FROM mock_accounts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toAccount(result.rows[0]) : undefined;
}

export async function listAccounts(): Promise<PublicAccountRecord[]> {
  const result = await database().query<PublicAccountRow>(
    `SELECT ${PUBLIC_ACCOUNT_FIELDS} FROM mock_accounts ORDER BY created_at DESC`,
  );
  return result.rows.map(toPublicAccount);
}

export async function getPublicAccountByMsisdn(msisdn: string): Promise<PublicAccountRecord | undefined> {
  const result = await database().query<PublicAccountRow>(
    `SELECT ${PUBLIC_ACCOUNT_FIELDS} FROM mock_accounts WHERE msisdn = $1`,
    [msisdn.replace(/\s+/g, "")],
  );
  return result.rows[0] ? toPublicAccount(result.rows[0]) : undefined;
}

export async function getTransactionsByAccountId(accountId: string): Promise<TransactionRecord[]> {
  const result = await database().query<TransactionRow>(
    `SELECT ${TRANSACTION_FIELDS} FROM mock_transactions WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId],
  );
  return result.rows.map(toTransaction);
}

export async function getTransactionsByMsisdn(msisdn: string): Promise<TransactionRecord[]> {
  const result = await database().query<TransactionRow>(
    `SELECT ${JOINED_TRANSACTION_FIELDS}
     FROM mock_transactions t JOIN mock_accounts a ON a.id = t.account_id
     WHERE a.msisdn = $1 ORDER BY t.created_at DESC`,
    [msisdn.replace(/\s+/g, "")],
  );
  return result.rows.map(toTransaction);
}

const insertLedger = async (
  client: PoolClient,
  input: Omit<TransactionRecord, "id" | "createdAt">,
): Promise<TransactionRecord> => {
  const result = await client.query<TransactionRow>(
    `INSERT INTO mock_transactions
       (account_id, provider, type, amount, currency, status, reference, balance_before, balance_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${TRANSACTION_FIELDS}`,
    [input.accountId, input.provider, input.type, input.amount, input.currency, input.status,
      input.reference, input.balanceBefore, input.balanceAfter],
  );
  return toTransaction(result.rows[0]);
};

async function withLockedAccount<T>(
  accountId: string,
  operation: (client: PoolClient, account: AccountRecord) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_FIELDS} FROM mock_accounts WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    if (!result.rows[0]) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    const value = await operation(client, toAccount(result.rows[0]));
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function topUpAccount(accountId: string, amount: number, maxBalance: number): Promise<AccountRecord> {
  return withLockedAccount(accountId, async (client, account) => {
    if (account.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_BLOCKED", "Account is blocked");
    if (account.balance + amount > maxBalance) throw new ApiError(422, "MAX_BALANCE_EXCEEDED", "Top-up exceeds the maximum account balance");
    const updated = await client.query<AccountRow>(
      `UPDATE mock_accounts SET balance = balance + $2, updated_at = NOW()
       WHERE id = $1 RETURNING ${ACCOUNT_FIELDS}`,
      [accountId, amount],
    );
    await insertLedger(client, {
      accountId, provider: account.provider, type: "TOPUP", amount, currency: account.currency,
      status: "SUCCESS", reference: randomUUID(), balanceBefore: account.balance,
      balanceAfter: account.balance + amount,
    });
    return toAccount(updated.rows[0]);
  });
}

export async function resetAccount(accountId: string): Promise<AccountRecord> {
  return withLockedAccount(accountId, async (client, account) => {
    const updated = await client.query<AccountRow>(
      `UPDATE mock_accounts SET balance = 0, updated_at = NOW()
       WHERE id = $1 RETURNING ${ACCOUNT_FIELDS}`,
      [accountId],
    );
    await insertLedger(client, {
      accountId, provider: account.provider, type: "RESET", amount: account.balance,
      currency: account.currency, status: "SUCCESS", reference: randomUUID(),
      balanceBefore: account.balance, balanceAfter: 0,
    });
    return toAccount(updated.rows[0]);
  });
}

export type PaymentFailure = "ACCOUNT_NOT_FOUND" | "WRONG_PROVIDER" | "ACCOUNT_BLOCKED" | "INSUFFICIENT_BALANCE" | "DECLINED";
export interface PaymentSettlement {
  success: boolean;
  failure?: PaymentFailure;
  account?: PublicAccountRecord;
  balanceBefore?: number;
  balanceAfter?: number;
}

export async function settleWalletPayment(input: {
  provider: ProviderType;
  msisdn: string;
  amount: number;
  reference: string;
  allowPayment: boolean;
  forceBlocked?: boolean;
}): Promise<PaymentSettlement> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_FIELDS} FROM mock_accounts WHERE msisdn = $1 FOR UPDATE`,
      [input.msisdn.replace(/\s+/g, "")],
    );
    if (!result.rows[0]) {
      await client.query("COMMIT");
      return { success: false, failure: "ACCOUNT_NOT_FOUND" };
    }

    const account = toAccount(result.rows[0]);
    let failure: PaymentFailure | undefined;
    if (account.provider !== input.provider) failure = "WRONG_PROVIDER";
    else if (account.status !== "ACTIVE" || input.forceBlocked) failure = "ACCOUNT_BLOCKED";
    else if (account.balance < input.amount) failure = "INSUFFICIENT_BALANCE";
    else if (!input.allowPayment) failure = "DECLINED";

    const balanceAfter = failure ? account.balance : account.balance - input.amount;
    if (!failure) {
      await client.query(
        `UPDATE mock_accounts SET balance = $2, updated_at = NOW() WHERE id = $1`,
        [account.id, balanceAfter],
      );
    }
    await insertLedger(client, {
      accountId: account.id, provider: account.provider, type: "PAYMENT", amount: input.amount,
      currency: account.currency, status: failure ? "FAILED" : "SUCCESS", reference: input.reference,
      balanceBefore: account.balance, balanceAfter,
    });
    await client.query("COMMIT");

    return {
      success: !failure,
      failure,
      account: (({ passwordHash: _passwordHash, ...publicAccount }) => ({ ...publicAccount, balance: balanceAfter }))(account),
      balanceBefore: account.balance,
      balanceAfter,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}