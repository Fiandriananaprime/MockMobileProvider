import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../shared/errors.js";
import { constantTimeEqual, parseAuthorizationHeader } from "../shared/secrets.js";
import { getPublicAccountByMsisdn, getTransactionsByMsisdn, listAccounts } from "../db.js";

const requireAdminAuth = (authorization: string | undefined): void => {
  const expected = process.env.MOCK_ADMIN_TOKEN ?? "";
  const supplied = parseAuthorizationHeader(authorization, "Bearer");
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    throw new ApiError(401, "UNAUTHORIZED", "Valid mock admin token required");
  }
};

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin/")) return;
    requireAdminAuth(req.headers.authorization);
  });

  app.get("/admin/accounts", async () => listAccounts());

  app.get("/admin/accounts/:msisdn", async (req) => {
    const msisdn = (req.params as { msisdn: string }).msisdn;
    const account = await getPublicAccountByMsisdn(msisdn);
    if (!account) throw new ApiError(404, "ACCOUNT_NOT_FOUND", `Unknown account ${msisdn}`);
    return account;
  });

  app.get("/admin/accounts/:msisdn/transactions", async (req) => {
    const msisdn = (req.params as { msisdn: string }).msisdn;
    const account = await getPublicAccountByMsisdn(msisdn);
    if (!account) throw new ApiError(404, "ACCOUNT_NOT_FOUND", `Unknown account ${msisdn}`);
    return getTransactionsByMsisdn(msisdn);
  });
};
