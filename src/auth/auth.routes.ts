import type { FastifyPluginAsync } from "fastify";
import { createAccount, getAccountByMsisdn } from "../db.js";
import { loadRuntimeConfig, type ProviderType } from "../config.js";
import { ApiError } from "../shared/errors.js";
import { createUserAccessToken, hashPassword, validatePassword, verifyPassword } from "./user-auth.js";

const publicAccount = (account: { provider: ProviderType; msisdn: string; balance: number; currency: string; status: string }) => ({
  provider: account.provider,
  msisdn: account.msisdn,
  balance: account.balance,
  currency: account.currency,
  status: account.status,
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/register", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.provider !== "MVOLA" && body.provider !== "ORANGE_MONEY") {
      throw new ApiError(400, "INVALID_PROVIDER", "provider must be MVOLA or ORANGE_MONEY");
    }
    if (!validatePassword(body.password)) {
      throw new ApiError(400, "INVALID_PASSWORD", "password must contain between 8 and 128 characters");
    }

    const config = loadRuntimeConfig();
    const passwordHash = await hashPassword(body.password);
    const account = await createAccount(body.provider, config.msisdnPrefixes[body.provider], passwordHash);
    return reply.code(201).send(publicAccount(account));
  });

  app.post("/auth/login", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.msisdn !== "string" || !/^\d{10}$/.test(body.msisdn) ||
      typeof body.password !== "string" || body.password.length > 128) {
      throw new ApiError(400, "INVALID_CREDENTIALS", "msisdn and password are required");
    }

    const account = await getAccountByMsisdn(body.msisdn);
    if (!account || !(await verifyPassword(body.password, account.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "MSISDN or password is incorrect");
    }
    if (account.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_BLOCKED", "Account is blocked");

    return {
      accessToken: await createUserAccessToken(account.id),
      tokenType: "Bearer",
      expiresIn: 3600,
    };
  });
};