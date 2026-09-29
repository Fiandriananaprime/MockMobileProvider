import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { buildServer } from "../dist/server.js";
import { configureMock } from "../dist/mock/mock.service.js";
import { runDatabaseMigrations } from "../dist/migrations.js";

const adminToken = "test-admin-token-012345678901234567890";
const userSecret = "test-user-auth-secret-with-at-least-32-bytes";
const previousEnvironment = {};
const envNames = [
  "NODE_ENV", "DATABASE_URL", "USER_AUTH_SECRET", "MOCK_ADMIN_TOKEN", "MAX_BALANCE",
  "MVOLA_MSISDN_PREFIXES", "ORANGE_MONEY_MSISDN_PREFIXES", "USER_FRONTEND_ORIGINS",
  "ADMIN_FRONTEND_ORIGINS", "CALLBACK_ALLOWED_HOSTS", "MVOLA_CLIENT_KEY",
  "MVOLA_CLIENT_SECRET", "ORANGE_BASIC_AUTH",
];
let app;
let database;
let databaseAdmin;
let testSchema;
let mvolaAccessToken;
let orangeAccessToken;

before(async () => {
  for (const name of envNames) previousEnvironment[name] = process.env[name];
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required for integration tests");
  databaseAdmin = new Pool({ connectionString: baseDatabaseUrl });
  testSchema = `wallet_test_${randomUUID().replaceAll("-", "")}`;
  await databaseAdmin.query(`CREATE SCHEMA "${testSchema}"`);
  const isolatedDatabaseUrl = new URL(baseDatabaseUrl);
  isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString();
  process.env.NODE_ENV = "production";
  process.env.USER_AUTH_SECRET = userSecret;
  process.env.MOCK_ADMIN_TOKEN = adminToken;
  process.env.MAX_BALANCE = "10000000";
  process.env.MVOLA_MSISDN_PREFIXES = "034,038";
  process.env.ORANGE_MONEY_MSISDN_PREFIXES = "032,037";
  process.env.USER_FRONTEND_ORIGINS = "http://localhost:5175";
  process.env.ADMIN_FRONTEND_ORIGINS = "http://localhost:5176";
  process.env.CALLBACK_ALLOWED_HOSTS = "callbacks.example";
  process.env.MVOLA_CLIENT_KEY = "test-mvola-key";
  process.env.MVOLA_CLIENT_SECRET = "test-mvola-secret";
  process.env.ORANGE_BASIC_AUTH = `Basic ${Buffer.from("test-orange-client").toString("base64")}`;
  app = await buildServer();
  database = new Pool({ connectionString: process.env.DATABASE_URL });
  mvolaAccessToken = await getProviderToken("/token", `Basic ${Buffer.from("test-mvola-key:test-mvola-secret").toString("base64")}`);
  orangeAccessToken = await getProviderToken("/oauth/v3/token", process.env.ORANGE_BASIC_AUTH);
});

after(async () => {
  await app.close();
  await database.end();
  await databaseAdmin.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  await databaseAdmin.end();
  for (const name of envNames) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
});

async function getProviderToken(url, authorization) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
    payload: "grant_type=client_credentials",
  });
  assert.equal(response.statusCode, 200);
  return response.json().access_token;
}

async function register(provider = "MVOLA", password = "secret123") {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { provider, password },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function login(account, password = "secret123") {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { msisdn: account.msisdn, password },
  });
}

const bearer = (accessToken) => ({ authorization: `Bearer ${accessToken}` });

async function topUp(accessToken, amount) {
  return app.inject({
    method: "POST",
    url: "/account/topup",
    headers: bearer(accessToken),
    payload: { amount },
  });
}

function setScenario(scenario = "success", settleDelayMs = 0) {
  configureMock({ scenario, settleDelayMs });
}

async function waitForMvola(serverCorrelationId) {
  const headers = {
    ...bearer(mvolaAccessToken),
    version: "1.0",
    "x-correlationid": randomUUID(),
    userlanguage: "FR",
    useraccountidentifier: "msisdn;0343500001",
    partnername: "Test",
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const status = response.json().status;
    if (status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("MVola payment did not settle in time");
}

async function startMvolaPayment(msisdn, amount) {
  const response = await app.inject({
    method: "POST",
    url: "/mvola/mm/transactions/type/merchantpay/1.0.0/",
    headers: {
      ...bearer(mvolaAccessToken),
      version: "1.0",
      "x-correlationid": randomUUID(),
      userlanguage: "FR",
      useraccountidentifier: "msisdn;0343500001",
      partnername: "Test",
      "content-type": "application/json",
    },
    payload: {
      amount: String(amount),
      currency: "Ar",
      descriptionText: "Account settlement test",
      requestingOrganisationTransactionReference: randomUUID(),
      requestDate: new Date().toISOString(),
      debitParty: [{ key: "msisdn", value: msisdn }],
      creditParty: [{ key: "msisdn", value: "0343500001" }],
    },
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().serverCorrelationId;
}

async function createOrangePayment(msisdn, amount = 100, shouldConfirm = true) {
  const orderId = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: "/orange-money-webpay/dev/v1/webpayment",
    headers: { ...bearer(orangeAccessToken), "content-type": "application/json" },
    payload: {
      merchant_key: "merchant-test",
      currency: "MGA",
      order_id: orderId,
      amount,
      return_url: "https://shop.example/return",
      cancel_url: "https://shop.example/cancel",
      notif_url: "https://callbacks.example/notif",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const payment = { ...created.json(), order_id: orderId, amount };
  if (!shouldConfirm) return { payment };
  const confirmed = await app.inject({
    method: "POST",
    url: `/__mock/orange/pay/${payment.pay_token}/confirm`,
    headers: { "content-type": "application/json" },
    payload: { msisdn },
  });
  return { payment, confirmed };
}

async function waitForOrange(payment) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/orange-money-webpay/dev/v1/transactionstatus",
      headers: { ...bearer(orangeAccessToken), "content-type": "application/json" },
      payload: { order_id: payment.order_id, amount: payment.amount ?? 100, pay_token: payment.pay_token },
    });
    assert.equal(response.statusCode, 200, response.body);
    const status = response.json().status;
    if (status !== "PENDING" && status !== "INITIATED") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Orange payment did not settle in time");
}

test("registration generates unique provider numbers and stores only password hashes", async () => {
  const mvola = await register("MVOLA");
  const orange = await register("ORANGE_MONEY");
  assert.match(mvola.msisdn, /^(034|038)\d{7}$/);
  assert.match(orange.msisdn, /^(032|037)\d{7}$/);
  assert.notEqual(mvola.msisdn, orange.msisdn);
  for (const account of [mvola, orange]) {
    assert.equal(account.balance, 0);
    assert.equal(account.currency, "MGA");
    assert.equal(account.status, "ACTIVE");
    assert.equal("password_hash" in account, false);
    assert.equal("passwordHash" in account, false);
  }
  const stored = await database.query("SELECT password_hash FROM mock_accounts WHERE msisdn = $1", [mvola.msisdn]);
  assert.match(stored.rows[0].password_hash, /^scrypt\$16384\$/);
  assert.notEqual(stored.rows[0].password_hash, "secret123");
});

test("deployment migration runner records applied migrations and is safe to rerun", async () => {
  const results = await Promise.all([
    runDatabaseMigrations(database),
    runDatabaseMigrations(database),
  ]);
  assert.deepEqual(results, [[], []]);
  const recorded = await database.query("SELECT name FROM schema_migrations ORDER BY name");
  assert.deepEqual(recorded.rows.map((row) => row.name), ["001_mock_user_accounts.sql"]);
});

test("login issues a user-only token and account identity comes from that token", async () => {
  const user = await register();
  const valid = await login(user);
  assert.equal(valid.statusCode, 200);
  const { accessToken, tokenType, expiresIn } = valid.json();
  assert.equal(tokenType, "Bearer");
  assert.equal(expiresIn, 3600);
  assert.ok(accessToken);
  assert.equal((await login(user, "wrong-password")).statusCode, 401);

  const account = await app.inject({ method: "GET", url: `/account?msisdn=0000000000`, headers: bearer(accessToken) });
  assert.equal(account.statusCode, 200);
  assert.equal(account.json().msisdn, user.msisdn);
  assert.equal((await app.inject({ method: "GET", url: "/account", headers: bearer(adminToken) })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/admin/accounts", headers: bearer(accessToken) })).statusCode, 401);
});

test("users can top up repeatedly, amounts are validated, and MAX_BALANCE is enforced", async () => {
  const user = await register();
  const accessToken = (await login(user)).json().accessToken;
  assert.equal((await topUp(accessToken, 100)).statusCode, 200);
  assert.equal((await topUp(accessToken, 200)).json().balance, 300);
  for (const amount of [0, -1, "500", null]) {
    assert.equal((await topUp(accessToken, amount)).statusCode, 400);
  }

  const fullAccount = await register();
  const fullToken = (await login(fullAccount)).json().accessToken;
  const maxed = await topUp(fullToken, 10_000_000);
  assert.equal(maxed.statusCode, 200);
  const refused = await topUp(fullToken, 1);
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().error, "MAX_BALANCE_EXCEEDED");
  assert.equal((await app.inject({ method: "GET", url: "/account/balance", headers: bearer(fullToken) })).json().balance, 10_000_000);

  const ledger = await app.inject({ method: "GET", url: "/account/transactions", headers: bearer(accessToken) });
  assert.deepEqual(ledger.json().transactions.slice(0, 2).map((transaction) => transaction.type), ["TOPUP", "TOPUP"]);
  assert.equal(ledger.json().transactions[0].status, "SUCCESS");
});

test("reset and transaction reads are restricted to the authenticated wallet", async () => {
  const userA = await register();
  const userB = await register();
  const tokenA = (await login(userA)).json().accessToken;
  const tokenB = (await login(userB)).json().accessToken;
  await topUp(tokenB, 900);
  await topUp(tokenA, 250);

  const ownTransactions = await app.inject({ method: "GET", url: "/account/transactions", headers: bearer(tokenA) });
  assert.equal(ownTransactions.statusCode, 200);
  assert.equal(ownTransactions.json().transactions.length, 1);
  assert.equal(ownTransactions.json().transactions[0].type, "TOPUP");

  const reset = await app.inject({ method: "POST", url: "/account/reset", headers: bearer(tokenA) });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().balance, 0);
  const resetTransaction = (await app.inject({ method: "GET", url: "/account/transactions", headers: bearer(tokenA) })).json().transactions[0];
  assert.equal(resetTransaction.type, "RESET");
  assert.equal(resetTransaction.amount, 250);
  assert.equal(resetTransaction.balanceBefore, 250);
  assert.equal(resetTransaction.balanceAfter, 0);

  assert.equal((await app.inject({ method: "POST", url: `/account/${userB.msisdn}/reset`, headers: bearer(tokenA) })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/account/${userB.msisdn}/topup`, headers: bearer(tokenA), payload: { amount: 500 } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/account/balance", headers: bearer(tokenB) })).json().balance, 900);
});

test("blocked accounts cannot log in or use an existing user token", async () => {
  const user = await register();
  const accessToken = (await login(user)).json().accessToken;
  await database.query("UPDATE mock_accounts SET status = 'BLOCKED' WHERE msisdn = $1", [user.msisdn]);
  assert.equal((await login(user)).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/account", headers: bearer(accessToken) })).statusCode, 403);
});

test("MVola debits only matching active wallets and records successful and failed payments", async () => {
  await setScenario("success", 0);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const funded = await register("MVOLA");
    const fundedToken = (await login(funded)).json().accessToken;
    await topUp(fundedToken, 5000);
    const successId = await startMvolaPayment(funded.msisdn, 1200);
    assert.equal(await waitForMvola(successId), "completed");
    assert.equal((await app.inject({ method: "GET", url: "/account/balance", headers: bearer(fundedToken) })).json().balance, 3800);

    const empty = await register("MVOLA");
    const insufficientId = await startMvolaPayment(empty.msisdn, 1);
    assert.equal(await waitForMvola(insufficientId), "failed");

    const orange = await register("ORANGE_MONEY");
    const wrongProviderId = await startMvolaPayment(orange.msisdn, 1);
    assert.equal(await waitForMvola(wrongProviderId), "failed");

    const missingId = await startMvolaPayment("0000000000", 1);
    assert.equal(await waitForMvola(missingId), "failed");

    const blocked = await register("MVOLA");
    await database.query("UPDATE mock_accounts SET status = 'BLOCKED' WHERE msisdn = $1", [blocked.msisdn]);
    const blockedId = await startMvolaPayment(blocked.msisdn, 1);
    assert.equal(await waitForMvola(blockedId), "failed");

    const transactions = await database.query(
      "SELECT type, status, balance_before, balance_after FROM mock_transactions WHERE account_id = (SELECT id FROM mock_accounts WHERE msisdn = $1) ORDER BY created_at",
      [funded.msisdn],
    );
    assert.deepEqual(transactions.rows.map((row) => row.type), ["TOPUP", "PAYMENT"]);
    assert.equal(transactions.rows[1].status, "SUCCESS");
    assert.equal(Number(transactions.rows[1].balance_after), 3800);
  } finally {
    Math.random = originalRandom;
  }
});

test("Orange WebPay settles against a real Orange wallet, not a fixed profile", async () => {
  await setScenario("success", 0);
  const originalRandom = Math.random;
  const originalFetch = globalThis.fetch;
  Math.random = () => 0;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const orange = await register("ORANGE_MONEY");
    const token = (await login(orange)).json().accessToken;
    await topUp(token, 500);
    const { payment, confirmed } = await createOrangePayment(orange.msisdn, 200);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(await waitForOrange(payment), "SUCCESS");
    assert.equal((await app.inject({ method: "GET", url: "/account/balance", headers: bearer(token) })).json().balance, 300);

    const mvola = await register("MVOLA");
    const rejected = await createOrangePayment(mvola.msisdn);
    assert.equal(rejected.confirmed.statusCode, 400);
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("Orange hosted checkout renders the active persisted wallet list", async () => {
  const orange = await register("ORANGE_MONEY");
  const { payment } = await createOrangePayment(orange.msisdn, 375, false);
  const page = await app.inject({ method: "GET", url: `/__mock/orange/pay/${payment.pay_token}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] ?? "", /text\/html/);
  assert.match(page.body, /Orange Money/);
  assert.match(page.body, /Confirmer le paiement/);
  assert.match(page.body, new RegExp(orange.msisdn));
  assert.match(page.body, /wallet-option/);
  assert.match(page.body, /viewport/);
});

test("simultaneous MVola payments cannot overdraw the same PostgreSQL wallet", async () => {
  await setScenario("success", 0);
  const user = await register("MVOLA");
  const token = (await login(user)).json().accessToken;
  await topUp(token, 10_000);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const [firstId, secondId] = await Promise.all([
      startMvolaPayment(user.msisdn, 8000),
      startMvolaPayment(user.msisdn, 8000),
    ]);
    const statuses = await Promise.all([waitForMvola(firstId), waitForMvola(secondId)]);
    assert.deepEqual(statuses.sort(), ["completed", "failed"]);
    const account = await app.inject({ method: "GET", url: "/account/balance", headers: bearer(token) });
    assert.equal(account.json().balance, 2000);
    assert.ok(account.json().balance >= 0);
    const payments = await database.query(
      "SELECT status, balance_before, balance_after FROM mock_transactions WHERE account_id = (SELECT id FROM mock_accounts WHERE msisdn = $1) AND type = 'PAYMENT'",
      [user.msisdn],
    );
    assert.equal(payments.rowCount, 2);
    assert.deepEqual(payments.rows.map((row) => row.status).sort(), ["FAILED", "SUCCESS"]);
    assert.ok(payments.rows.every((row) => Number(row.balance_after) >= 0));
  } finally {
    Math.random = originalRandom;
  }
});