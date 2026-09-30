import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { buildServer } from "../dist/server.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { isCallbackUrlAllowed } from "../dist/shared/callback-url.js";

const adminToken = "test-admin-token-012345678901234567890";
const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  USER_AUTH_SECRET: process.env.USER_AUTH_SECRET,
  MAX_BALANCE: process.env.MAX_BALANCE,
  MOCK_PROVIDER_API_KEY: process.env.MOCK_PROVIDER_API_KEY,
  MVOLA_MSISDN_PREFIXES: process.env.MVOLA_MSISDN_PREFIXES,
  ORANGE_MONEY_MSISDN_PREFIXES: process.env.ORANGE_MONEY_MSISDN_PREFIXES,
  USER_FRONTEND_ORIGINS: process.env.USER_FRONTEND_ORIGINS,
  MOCK_ADMIN_TOKEN: process.env.MOCK_ADMIN_TOKEN,
  ADMIN_FRONTEND_ORIGINS: process.env.ADMIN_FRONTEND_ORIGINS,
  CALLBACK_ALLOWED_HOSTS: process.env.CALLBACK_ALLOWED_HOSTS,
  MVOLA_CLIENT_KEY: process.env.MVOLA_CLIENT_KEY,
  MVOLA_CLIENT_SECRET: process.env.MVOLA_CLIENT_SECRET,
  ORANGE_BASIC_AUTH: process.env.ORANGE_BASIC_AUTH,
};
let app;
let databaseAdmin;
let testSchema;

before(async () => {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required for integration tests");
  databaseAdmin = new Pool({ connectionString: baseDatabaseUrl });
  testSchema = `security_test_${randomUUID().replaceAll("-", "")}`;
  await databaseAdmin.query(`CREATE SCHEMA "${testSchema}"`);
  const isolatedDatabaseUrl = new URL(baseDatabaseUrl);
  isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString();
  process.env.NODE_ENV = "production";
  process.env.USER_AUTH_SECRET = "test-user-auth-secret-with-at-least-32-bytes";
  process.env.MAX_BALANCE = "10000000";
  process.env.MOCK_PROVIDER_API_KEY = "test-mock-provider-api-key-0123456789";
  process.env.MVOLA_MSISDN_PREFIXES = "034,038";
  process.env.ORANGE_MONEY_MSISDN_PREFIXES = "032,037";
  process.env.USER_FRONTEND_ORIGINS = "http://localhost:5175";
  process.env.ADMIN_FRONTEND_ORIGINS = "http://localhost:5176, https://mock-admin.example.com";
  process.env.MOCK_ADMIN_TOKEN = adminToken;
  process.env.CALLBACK_ALLOWED_HOSTS = "callbacks.example";
  process.env.MVOLA_CLIENT_KEY = "production-mvola-key";
  process.env.MVOLA_CLIENT_SECRET = "production-mvola-secret";
  process.env.ORANGE_BASIC_AUTH = `Basic ${Buffer.from("production-orange-client").toString("base64")}`;
  app = await buildServer();
});

after(async () => {
  await app.close();
  await databaseAdmin.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  await databaseAdmin.end();
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

test("mock profile, reset, config, and inspection routes are removed", async () => {
  for (const [method, url] of [
    ["GET", "/__mock/profiles"],
    ["GET", "/__mock/profiles/0341234567"],
    ["POST", "/__mock/reset"],
    ["GET", "/__mock/config"],
    ["POST", "/__mock/config"],
    ["GET", "/__mock/transactions"],
  ]) {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.statusCode, 404, `${method} ${url} must be removed`);
  }
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
      origin: "http://localhost:5175",
    },
    payload: "grant_type=client_credentials",
  });
  assert.equal(allowedMvola.statusCode, 200);
  assert.equal(allowedMvola.headers["access-control-allow-origin"], undefined);

  const lowercaseBasicMvola = await app.inject({
    method: "POST",
    url: "/token",
    headers: {
      authorization: `basic ${Buffer.from("production-mvola-key:production-mvola-secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "grant_type=client_credentials",
  });
  assert.equal(lowercaseBasicMvola.statusCode, 200);

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

  const lowercaseBasicOrange = await app.inject({
    method: "POST",
    url: "/oauth/v3/token",
    headers: {
      authorization: `basic ${Buffer.from("production-orange-client").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "grant_type=client_credentials",
  });
  assert.equal(lowercaseBasicOrange.statusCode, 200);
});

test("admin frontend origins are allowed with CORS while unknown origins are rejected", async () => {
  const authorized = await app.inject({
    method: "OPTIONS",
    url: "/admin/accounts",
    headers: {
      origin: "http://localhost:5176",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(authorized.statusCode, 204);
  assert.equal(authorized.headers["access-control-allow-origin"], "http://localhost:5176");
  assert.match(authorized.headers["access-control-allow-methods"] ?? "", /GET/);
  assert.match(authorized.headers["access-control-allow-headers"] ?? "", /Authorization/i);

  const secondary = await app.inject({
    method: "GET",
    url: "/admin/accounts",
    headers: {
      origin: "https://mock-admin.example.com",
      authorization: `Bearer ${adminToken}`,
    },
  });
  assert.equal(secondary.statusCode, 200);
  assert.equal(secondary.headers["access-control-allow-origin"], "https://mock-admin.example.com");

  const rejected = await app.inject({
    method: "OPTIONS",
    url: "/admin/accounts",
    headers: {
      origin: "https://unknown-site.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("CORS supports multiple origins and allows POST, PATCH, and DELETE preflight methods", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/admin/accounts",
      headers: {
        origin: "https://mock-admin.example.com",
        "access-control-request-method": method,
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://mock-admin.example.com");
    assert.match(preflight.headers["access-control-allow-methods"] ?? "", new RegExp(method));
  }

  const userOriginToAdmin = await app.inject({
    method: "GET",
    url: "/admin/accounts",
    headers: { origin: "http://localhost:5175", authorization: `Bearer ${adminToken}` },
  });
  assert.equal(userOriginToAdmin.headers["access-control-allow-origin"], undefined);

  const userPreflight = await app.inject({
    method: "OPTIONS",
    url: "/account",
    headers: {
      origin: "http://localhost:5175",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(userPreflight.statusCode, 204);
  assert.equal(userPreflight.headers["access-control-allow-origin"], "http://localhost:5175");

  const unknownUserOrigin = await app.inject({
    method: "OPTIONS",
    url: "/account",
    headers: {
      origin: "https://unknown-site.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(unknownUserOrigin.headers["access-control-allow-origin"], undefined);
});

test("production configuration validates database, secret, prefixes, and both frontend origin lists", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/mock_mobile_provider",
    USER_AUTH_SECRET: "test-user-auth-secret-with-at-least-32-bytes",
    USER_FRONTEND_ORIGINS: "https://mock-user.example.com",
    ADMIN_FRONTEND_ORIGINS: "https://mock-admin.example.com",
  };
  assert.throws(() => loadRuntimeConfig({ ...base, ADMIN_FRONTEND_ORIGINS: "" }), /ADMIN_FRONTEND_ORIGINS must be configured/i);
  assert.throws(() => loadRuntimeConfig({ ...base, USER_FRONTEND_ORIGINS: "*" }), /USER_FRONTEND_ORIGINS cannot contain/i);
  assert.throws(() => loadRuntimeConfig({ ...base, ADMIN_FRONTEND_ORIGINS: "ftp://example.com" }), /Invalid ADMIN_FRONTEND_ORIGINS entry/i);
  assert.throws(() => loadRuntimeConfig({ ...base, MVOLA_MSISDN_PREFIXES: "34" }), /three-digit prefixes/i);
});

test("admin account endpoints are read-only", async () => {
  const list = await app.inject({
    method: "GET",
    url: "/admin/accounts",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(list.statusCode, 200);
  assert.ok(Array.isArray(list.json()));
  assert.equal((list.json()[0] ?? {}).passwordHash, undefined);

  for (const url of ["/admin/accounts", "/admin/accounts/0341234567/topup", "/admin/accounts/0341234567/reset", "/admin/accounts/0341234567/block", "/admin/accounts/0341234567/unblock"]) {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 10 },
    });
    assert.equal(response.statusCode, 404, `${url} must not expose an admin wallet mutation`);
  }
});