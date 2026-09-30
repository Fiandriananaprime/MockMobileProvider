import "dotenv/config";
import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import { pathToFileURL } from "node:url";
import { accountRoutes } from "./accounts/account.routes.js";
import { authRoutes } from "./auth/auth.routes.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { closeDatabase, ensureDatabaseReady } from "./db.js";
import { ApiError } from "./shared/errors.js";
import { adminRoutes } from "./admin/admin.routes.js";
import { mvolaRoutes } from "./providers/mvola/mvola.routes.js";
import { orangeRoutes } from "./providers/orange-money/orange.routes.js";
import { mockRoutes } from "./mock/mock.routes.js";
import { verificationRoutes } from "./mock/verification.routes.js";

export async function buildServer(config: RuntimeConfig = loadRuntimeConfig()) {
  await ensureDatabaseReady(config);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Internal error";
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", message });
  });

  await app.register(cors, {
    delegator: (request, callback) => {
      const isAdminApi = request.url.startsWith("/admin/");
      const isUserApi = request.url.startsWith("/auth/") || request.url === "/account" || request.url.startsWith("/account/") || request.url.startsWith("/__mock/verification/");
      const allowedOrigins = isAdminApi
        ? config.adminFrontendOrigins
        : isUserApi
          ? config.userFrontendOrigins
          : [];
      callback(null, {
        origin: (origin, originCallback) => originCallback(null, Boolean(origin && allowedOrigins.includes(origin))),
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false,
      });
    },
  });

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(formbody);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(adminRoutes);
  await app.register(mvolaRoutes);
  await app.register(orangeRoutes);
  await app.register(mockRoutes);
  await app.register(verificationRoutes);
  app.addHook("onClose", closeDatabase);
  return app;
}

async function start(): Promise<void> {
  const config = loadRuntimeConfig();
  const adminToken = process.env.MOCK_ADMIN_TOKEN ?? "";
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(adminToken, "utf8") < 32) {
    throw new Error("MOCK_ADMIN_TOKEN must contain at least 32 bytes when NODE_ENV=production");
  }
  if (process.env.NODE_ENV === "production" && (!process.env.MVOLA_CLIENT_KEY?.trim() || !process.env.MVOLA_CLIENT_SECRET?.trim())) {
    throw new Error("MVOLA_CLIENT_KEY and MVOLA_CLIENT_SECRET are required when NODE_ENV=production");
  }
  if (process.env.NODE_ENV === "production" && !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(process.env.ORANGE_BASIC_AUTH ?? "")) {
    throw new Error("ORANGE_BASIC_AUTH must be a Basic authorization value when NODE_ENV=production");
  }
  const callbackHosts = (process.env.CALLBACK_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && callbackHosts.length === 0) {
    throw new Error("CALLBACK_ALLOWED_HOSTS must contain at least one hostname when NODE_ENV=production");
  }
  if (process.env.NODE_ENV === "production") {
    const publicBaseUrl = process.env.PUBLIC_BASE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
    let publicUrl: URL;
    try {
      publicUrl = new URL(publicBaseUrl);
    } catch {
      throw new Error("PUBLIC_BASE_URL (or VERCEL_URL) must be an absolute HTTPS URL in production");
    }
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      throw new Error("PUBLIC_BASE_URL (or VERCEL_URL) must be an absolute HTTPS URL in production");
    }
  }

  const port = Number(process.env.PORT ?? 4010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const app = await buildServer(config);
  await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Closing server");
    try {
      await app.close();
    } catch (err) {
      app.log.error(err, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

let serverlessAppPromise: ReturnType<typeof buildServer> | undefined;

export default async function serverlessHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    serverlessAppPromise ??= buildServer();
    const app = await serverlessAppPromise;
    await app.ready();
    app.server.emit("request", request, response);
  } catch (error) {
    serverlessAppPromise = undefined;
    const message = error instanceof Error ? error.message : "Internal server error";
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "INTERNAL_ERROR", message }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}