import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { mvolaRoutes } from "./providers/mvola/mvola.routes.js";
import { orangeRoutes } from "./providers/orange-money/orange.routes.js";
import { mockRoutes } from "./mock/mock.routes.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(formbody); // /token and /oauth/v3/token are form-encoded
  await app.register(mvolaRoutes);
  await app.register(orangeRoutes);
  await app.register(mockRoutes);
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 4010);
  buildServer()
    .then((app) => app.listen({ port, host: "0.0.0.0" }))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
