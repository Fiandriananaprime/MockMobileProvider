import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildServer } from "../dist/server.js";
import { isCallbackUrlAllowed } from "../dist/shared/callback-url.js";

const adminToken = "test-admin-token-012345678901234567890";
const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  MOCK_ADMIN_TOKEN: process.env.MOCK_ADMIN_TOKEN,
  CALLBACK_ALLOWED_HOSTS: process.env.CALLBACK_ALLOWED_HOSTS,
  MVOLA_CLIENT_KEY: process.env.MVOLA_CLIENT_KEY,
  MVOLA_CLIENT_SECRET: process.env.MVOLA_CLIENT_SECRET,
  ORANGE_BASIC_AUTH: process.env.ORANGE_BASIC_AUTH,
};
let app;

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.MOCK_ADMIN_TOKEN = adminToken;
  process.env.CALLBACK_ALLOWED_HOSTS = "callbacks.example";
  process.env.MVOLA_CLIENT_KEY = "production-mvola-key";
  process.env.MVOLA_CLIENT_SECRET = "production-mvola-secret";
  process.env.ORANGE_BASIC_AUTH = `Basic ${Buffer.from("production-orange-client").toString("base64")}`;
  app = await buildServer();
});

after(async () => {
  await app.close();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("health endpoint is available without admin authentication", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("production mock administration requires the configured bearer token", async () => {
  const denied = await app.inject({ method: "GET", url: "/__mock/config" });
  assert.equal(denied.statusCode, 401);

  const allowed = await app.inject({
    method: "GET",
    url: "/__mock/config",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(allowed.statusCode, 200);
});

test("Orange hosted payment routes use the pay token capability", async () => {
  const response = await app.inject({ method: "GET", url: `/__mock/orange/pay/${"a".repeat(64)}` });
  assert.equal(response.statusCode, 404);
});

test("production callbacks require HTTPS and an allowlisted hostname", () => {
  assert.equal(isCallbackUrlAllowed("https://callbacks.example/notify"), true);
  assert.equal(isCallbackUrlAllowed("http://callbacks.example/notify"), false);
  assert.equal(isCallbackUrlAllowed("https://untrusted.example/notify"), false);
  assert.equal(isCallbackUrlAllowed("https://user:pass@callbacks.example/notify"), false);
});

test("provider token endpoints require configured Basic credentials in production", async () => {
  const deniedMvola = await app.inject({
    method: "POST",
    url: "/token",
    headers: { authorization: "Basic Zm9vOmJhcg==", "content-type": "application/x-www-form-urlencoded" },
    payload: "grant_type=client_credentials",
  });
  assert.equal(deniedMvola.statusCode, 401);

  const allowedMvola = await app.inject({
    method: "POST",
    url: "/token",
    headers: {
      authorization: `Basic ${Buffer.from("production-mvola-key:production-mvola-secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "grant_type=client_credentials",
  });
  assert.equal(allowedMvola.statusCode, 200);

  const deniedOrange = await app.inject({
    method: "POST",
    url: "/oauth/v3/token",
    headers: { authorization: "Basic Zm9v", "content-type": "application/x-www-form-urlencoded" },
    payload: "grant_type=client_credentials",
  });
  assert.equal(deniedOrange.statusCode, 401);

  const allowedOrange = await app.inject({
    method: "POST",
    url: "/oauth/v3/token",
    headers: {
      authorization: `Basic ${Buffer.from("production-orange-client").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "grant_type=client_credentials",
  });
  assert.equal(allowedOrange.statusCode, 200);
});