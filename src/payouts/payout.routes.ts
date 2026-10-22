import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadRuntimeConfig } from "../config.js";
import { getPayoutById, getPayoutByIdempotencyKey, executeWalletPayout } from "../db.js";
import { isCallbackUrlAllowed } from "../shared/callback-url.js";
import { ApiError } from "../shared/errors.js";

const requireProviderKey = (header: string | string[] | undefined): void => {
  const expected = Buffer.from(loadRuntimeConfig().providerApiKey);
  const received = typeof header === "string" ? Buffer.from(header) : undefined;
  if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ApiError(401, "INVALID_PROVIDER_API_KEY", "A valid provider API key is required");
  }
};

type PayoutCallback = {
  payoutId: string;
  reference: string;
  provider: string;
  status: "COMPLETED" | "FAILED";
  failureReason: string | null;
  amount: number;
  currency: string;
  idempotencyKey: string;
};

async function deliverPayoutCallback(url: string, payload: PayoutCallback, apiKey: string): Promise<void> {
  // The provider commits the payout before notifying Payment Service. Retry transient
  // failures because the callback may be the only confirmation after a client timeout.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "idempotency-key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      console.warn(`[payout] callback returned HTTP ${response.status} (attempt ${attempt + 1})`);
    } catch (error) {
      console.warn(`[payout] callback delivery failed (attempt ${attempt + 1}):`, (error as Error).message);
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
}

export const payoutRoutes: FastifyPluginAsync = async (app) => {
  app.post("/internal/payouts", async (request, reply) => {
    requireProviderKey(request.headers["x-api-key"]);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const senderMsisdn = body.senderMsisdn;
    const recipientMsisdn = body.recipientMsisdn;
    const provider = body.provider;
    const amount = body.amount;
    const reference = body.reference;
    const callbackUrl = body.callbackUrl;
    const clientPayoutId = body.clientPayoutId;
    const idempotencyKey = request.headers["idempotency-key"] ?? body.idempotencyKey;

    if (provider !== "MVOLA" && provider !== "ORANGE_MONEY") {
      throw new ApiError(400, "INVALID_PROVIDER", "provider must be MVOLA or ORANGE_MONEY");
    }
    if (typeof senderMsisdn !== "string" || !/^\\d{10}$/.test(senderMsisdn) ||
        typeof recipientMsisdn !== "string" || !/^\\d{10}$/.test(recipientMsisdn)) {
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
    if (typeof callbackUrl !== "string" || !isCallbackUrlAllowed(callbackUrl)) {
      throw new ApiError(400, "INVALID_CALLBACK_URL", "callbackUrl must be an allowed HTTP(S) callback URL");
    }
    if (typeof clientPayoutId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientPayoutId)) {
      throw new ApiError(400, "INVALID_CLIENT_PAYOUT_ID", "clientPayoutId must be a UUID");
    }

    const result = await executeWalletPayout({
      provider,
      senderMsisdn,
      recipientMsisdn,
      amount,
      reference: reference.trim(),
      idempotencyKey: idempotencyKey.trim(),
    });
    const payout = result.payout;
    const payload: PayoutCallback = {
      payoutId: clientPayoutId,
      reference: payout.reference,
      provider: payout.provider,
      status: payout.status,
      failureReason: payout.failureReason,
      amount: payout.amount,
      currency: payout.currency,
      idempotencyKey: idempotencyKey.trim(),
    };
    // Do not hold the API response open for callback delivery. The payment service
    // may already have committed its PROCESSING payout when this notification arrives.
    setTimeout(() => void deliverPayoutCallback(callbackUrl, payload, loadRuntimeConfig().providerApiKey), 500).unref();
    return reply.code(result.replayed ? 200 : 201).send(payout);
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
