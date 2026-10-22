import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadRuntimeConfig } from "../config.js";
import { getPayoutById, getPayoutByIdempotencyKey, executeWalletPayout } from "../db.js";
import { ApiError } from "../shared/errors.js";

const requireProviderKey = (header: string | string[] | undefined): void => {
  const expected = Buffer.from(loadRuntimeConfig().providerApiKey);
  const received = typeof header === "string" ? Buffer.from(header) : undefined;
  if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ApiError(401, "INVALID_PROVIDER_API_KEY", "A valid provider API key is required");
  }
};

export const payoutRoutes: FastifyPluginAsync = async (app) => {
  app.post("/internal/payouts", async (request, reply) => {
    requireProviderKey(request.headers["x-api-key"]);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const senderMsisdn = body.senderMsisdn;
    const recipientMsisdn = body.recipientMsisdn;
    const provider = body.provider;
    const amount = body.amount;
    const reference = body.reference;
    const idempotencyKey = request.headers["idempotency-key"] ?? body.idempotencyKey;

    if (provider !== "MVOLA" && provider !== "ORANGE_MONEY") {
      throw new ApiError(400, "INVALID_PROVIDER", "provider must be MVOLA or ORANGE_MONEY");
    }
    if (typeof senderMsisdn !== "string" || !/^\d{10}$/.test(senderMsisdn) ||
        typeof recipientMsisdn !== "string" || !/^\d{10}$/.test(recipientMsisdn)) {
      throw new ApiError(400, "INVALID_MSISDN", "senderMsisdn and recipientMsisdn must contain 10 digits");
    }
    if (senderMsisdn === recipientMsisdn) {
      throw new ApiError(400, "INVALID_RECIPIENT", "Sender and recipient must be different accounts");
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || Number(amount.toFixed(2)) !== amount) {
      throw new ApiError(400, "INVALID_AMOUNT", "amount must be a positive amount with at most 2 decimal places");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 128) {
      throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Provide an Idempotency-Key header (8-128 characters)");
    }
    if (typeof reference !== "string" || !reference.trim() || reference.length > 120) {
      throw new ApiError(400, "INVALID_REFERENCE", "reference must contain 1-120 characters");
    }

    const result = await executeWalletPayout({
      provider,
      senderMsisdn,
      recipientMsisdn,
      amount,
      reference: reference.trim(),
      idempotencyKey: idempotencyKey.trim(),
    });
    return reply.code(result.replayed ? 200 : 201).send(result.payout);
  });

  app.get("/internal/payouts/:payoutId", async (request) => {
    requireProviderKey(request.headers["x-api-key"]);
    const { payoutId } = request.params as { payoutId: string };
    const payout = await getPayoutById(payoutId);
    if (!payout) throw new ApiError(404, "PAYOUT_NOT_FOUND", "Payout not found");
    return payout;
  });

  app.get("/internal/payouts/by-idempotency/:key", async (request) => {
    requireProviderKey(request.headers["x-api-key"]);
    const { key } = request.params as { key: string };
    const payout = await getPayoutByIdempotencyKey(key);
    if (!payout) throw new ApiError(404, "PAYOUT_NOT_FOUND", "Payout not found");
    return payout;
  });
};
