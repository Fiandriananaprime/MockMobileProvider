import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { loadRuntimeConfig } from "../config.js";
import { ApiError } from "../shared/errors.js";
import {
  listNotifications,
  normalizePhoneNumber,
  sendVerification,
  subscribeToNotifications,
  verifyVerification,
} from "./verification.store.js";

const bodyOf = (request: { body?: unknown }): Record<string, unknown> =>
  (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;

const requireApiKey = (request: { headers: IncomingHttpHeaders }): void => {
  const expected = Buffer.from(loadRuntimeConfig().providerApiKey);
  const receivedHeader = request.headers["x-api-key"];
  const received = typeof receivedHeader === "string" ? Buffer.from(receivedHeader) : undefined;
  if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ApiError(401, "INVALID_PROVIDER_API_KEY", "A valid provider API key is required");
  }
};

export const verificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/__mock/verification/ws", { websocket: true }, (socket, request) => {
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber((request.query as { phoneNumber?: unknown } | undefined)?.phoneNumber);
    } catch {
      socket.close(1008, "Invalid phone number");
      return;
    }

    const unsubscribe = subscribeToNotifications(phoneNumber, socket);
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  app.post("/__mock/verification/sendVerification", async (request, reply) => {
    requireApiKey(request);
    const body = bodyOf(request);
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(body.phoneNumber);
    } catch {
      throw new ApiError(400, "INVALID_PHONE_NUMBER", "phoneNumber must be a valid international phone number");
    }

    const { expiresAt } = sendVerification(phoneNumber);
    return reply.code(202).send({ accepted: true, expiresAt });
  });

  app.post("/__mock/verification/verify", async (request) => {
    requireApiKey(request);
    const body = bodyOf(request);
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(body.phoneNumber);
    } catch {
      throw new ApiError(400, "INVALID_PHONE_NUMBER", "phoneNumber must be a valid international phone number");
    }
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      throw new ApiError(400, "INVALID_VERIFICATION_CODE", "code must contain 6 digits");
    }
    if (!verifyVerification(phoneNumber, body.code)) {
      throw new ApiError(400, "INVALID_VERIFICATION_CODE", "The verification code is invalid or expired");
    }
    return { verified: true };
  });

  app.get("/__mock/verification/notifications", async (request) => {
    const phoneNumber = normalizePhoneNumber((request.query as { phoneNumber?: unknown } | undefined)?.phoneNumber);
    return { notifications: listNotifications(phoneNumber) };
  });
};
