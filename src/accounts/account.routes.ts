import type { FastifyPluginAsync } from "fastify";
import { loadRuntimeConfig } from "../config.js";
import { getAccountIdentity, getTransactionsByAccountId, resetAccount, topUpAccount, updateAccountName } from "../db.js";
import { timingSafeEqual } from "node:crypto";
import { ApiError } from "../shared/errors.js";
import { requireUserAccount } from "../auth/user-auth.js";

const accountResponse = (account: {
  provider: string;
  msisdn: string;
  balance: number;
  currency: string;
  status: string;
  accountName: string | null;
}) => ({
  provider: account.provider,
  msisdn: account.msisdn,
  accountName: account.accountName,
  balance: account.balance,
  currency: account.currency,
  status: account.status,
});

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.patch("/account/name", async (request) => {
    const account = await requireUserAccount(request.headers.authorization);
    const accountName = (request.body as Record<string, unknown> | undefined)?.accountName;
    if (typeof accountName !== "string" || accountName.trim().length < 1 || accountName.trim().length > 120) {
      throw new ApiError(400, "INVALID_ACCOUNT_NAME", "accountName must contain between 1 and 120 characters");
    }
    return accountResponse(await updateAccountName(account.id, accountName.trim()));
  });

  app.get("/internal/accounts/:provider/:msisdn", async (request) => {
    const expected = Buffer.from(loadRuntimeConfig().providerApiKey);
    const header = request.headers["x-api-key"];
    const received = typeof header === "string" ? Buffer.from(header) : undefined;
    if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new ApiError(401, "INVALID_PROVIDER_API_KEY", "A valid provider API key is required");
    }
    const params = request.params as { provider?: string; msisdn?: string };
    if (params.provider !== "MVOLA" && params.provider !== "ORANGE_MONEY") {
      throw new ApiError(400, "INVALID_PROVIDER", "provider must be MVOLA or ORANGE_MONEY");
    }
    if (!params.msisdn || !/^\\d{10}$/.test(params.msisdn)) {
      throw new ApiError(400, "INVALID_MSISDN", "msisdn must contain 10 digits");
    }
    const identity = await getAccountIdentity(params.provider, params.msisdn);
    if (!identity) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    return identity;
  });
  app.get("/account", async (request) => accountResponse(await requireUserAccount(request.headers.authorization)));

  app.get("/account/balance", async (request) => {
    const account = await requireUserAccount(request.headers.authorization);
    return { balance: account.balance, currency: account.currency };
  });

  app.get("/account/transactions", async (request) => {
    const account = await requireUserAccount(request.headers.authorization);
    return { transactions: await getTransactionsByAccountId(account.id) };
  });

  app.post("/account/topup", async (request) => {
    const account = await requireUserAccount(request.headers.authorization);
    const amount = (request.body as Record<string, unknown> | undefined)?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, "INVALID_AMOUNT", "amount must be a positive number");
    }
    const updated = await topUpAccount(account.id, amount, loadRuntimeConfig().maxBalance);
    return accountResponse(updated);
  });

  app.post("/account/reset", async (request) => {
    const account = await requireUserAccount(request.headers.authorization);
    return accountResponse(await resetAccount(account.id));
  });
};