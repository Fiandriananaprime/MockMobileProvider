import type { FastifyPluginAsync } from "fastify";
import { loadRuntimeConfig } from "../config.js";
import { getTransactionsByAccountId, resetAccount, topUpAccount } from "../db.js";
import { ApiError } from "../shared/errors.js";
import { requireUserAccount } from "../auth/user-auth.js";

const accountResponse = (account: {
  provider: string;
  msisdn: string;
  balance: number;
  currency: string;
  status: string;
}) => ({
  provider: account.provider,
  msisdn: account.msisdn,
  balance: account.balance,
  currency: account.currency,
  status: account.status,
});

export const accountRoutes: FastifyPluginAsync = async (app) => {
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