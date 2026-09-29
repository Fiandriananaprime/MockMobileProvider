import { buildServer } from "../dist/server.js";

let serverPromise;

export default async function handler(request, response) {
  try {
    serverPromise ??= buildServer();
    const app = await serverPromise;
    await app.ready();
    app.server.emit("request", request, response);
  } catch (error) {
    serverPromise = undefined;
    const message = error instanceof Error ? error.message : "Internal server error";
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "INTERNAL_ERROR", message }));
  }
}