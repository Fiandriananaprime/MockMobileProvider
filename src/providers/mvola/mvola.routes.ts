import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ProviderHttpError } from "../../shared/errors";
import {
  SUPPORTED_PATH_VERSIONS,
  getTransactionDetails,
  getTransactionStatus,
  handleTokenRequest,
  initiatePayment,
} from "./mvola.service";
import { mvolaError } from "./mvola.types";

const BASE = "/mvola/mm/transactions/type/merchantpay";

const assertVersion = (v: string): void => {
  if (!SUPPORTED_PATH_VERSIONS.includes(v)) throw mvolaError(404, "validation", "notFound", `Unknown API version ${v}`);
};

export const mvolaRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated: errors on these routes use MVola-shaped bodies.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProviderHttpError) return reply.code(err.statusCode).send(err.body);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send(mvolaError(status, "validation", "formatError", (err as Error).message).body);
    }
    app.log.error(err);
    return reply.code(500).send(mvolaError(500, "internal", "genericError", "Internal error").body);
  });

  // OFFICIAL: POST /token (form-encoded, Basic auth)
  app.post("/token", async (req, reply) => reply.send(handleTokenRequest(req.headers, req.body)));

  // OFFICIAL: Initiate Transaction (documented with a trailing slash; both forms accepted)
  const initiate = async (req: FastifyRequest, reply: FastifyReply) => {
    assertVersion((req.params as { version: string }).version);
    const res = await initiatePayment(req.headers, req.body);
    // ASSUMPTION: HTTP 202 (any 2xx is safe for a well-written client).
    return reply.code(202).send(res);
  };
  app.post(`${BASE}/:version`, initiate);
  app.post(`${BASE}/:version/`, initiate);

  // OFFICIAL: Transaction Status
  app.get(`${BASE}/:version/status/:serverCorrelationId`, async (req, reply) => {
    const p = req.params as { version: string; serverCorrelationId: string };
    assertVersion(p.version);
    return reply.send(getTransactionStatus(req.headers, p.serverCorrelationId));
  });

  // OFFICIAL: Transaction Details
  app.get(`${BASE}/:version/:transId`, async (req, reply) => {
    const p = req.params as { version: string; transId: string };
    assertVersion(p.version);
    return reply.send(getTransactionDetails(req.headers, p.transId));
  });
};
