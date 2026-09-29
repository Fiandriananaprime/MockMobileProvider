import type { FastifyPluginAsync } from "fastify";
import { ProviderHttpError } from "../../shared/errors.js";
import {
  SUPPORTED_COUNTRY_SEGMENTS,
  createWebPayment,
  getTransactionStatus,
  handleTokenRequest,
} from "./orange.service.js";
import { orangeError } from "./orange.types.js";

const assertCountry = (c: string): void => {
  if (!SUPPORTED_COUNTRY_SEGMENTS.includes(c)) throw orangeError(404, 404, "Not Found", `Unknown path segment ${c}`);
};

export const orangeRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated: errors on these routes use Orange-shaped { code, message, description } bodies.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProviderHttpError) return reply.code(err.statusCode).send(err.body);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send(orangeError(status, 23, "Bad request", (err as Error).message).body);
    }
    app.log.error(err);
    return reply.code(500).send(orangeError(500, 500, "Internal Server Error", "Internal error").body);
  });

  // OFFICIAL: OAuth token endpoint (form-encoded)
  app.post("/oauth/v3/token", async (req, reply) => reply.send(handleTokenRequest(req.headers, req.body)));

  // OFFICIAL: Web payment initiation (HTTP 201)
  app.post("/orange-money-webpay/:country/v1/webpayment", async (req, reply) => {
    assertCountry((req.params as { country: string }).country);
    return reply.code(201).send(await createWebPayment(req.headers, req.body));
  });

  // OFFICIAL: Transaction status
  app.post("/orange-money-webpay/:country/v1/transactionstatus", async (req, reply) => {
    assertCountry((req.params as { country: string }).country);
    return reply.send(getTransactionStatus(req.headers, req.body));
  });
};
