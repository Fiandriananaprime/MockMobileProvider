# mock-mobile-money-service

A **MVola** and **Orange Money** simulator with persistent user wallets for local development and testing of the NovaMarket Payment Service.

- Node.js ≥ 20, TypeScript, Fastify, REST
- PostgreSQL-backed accounts and wallet transaction ledger
- Provider access tokens and in-flight MVola/Orange transactions remain in memory
- Configured payment notifications are outbound HTTP requests

> This is a development/test simulator, not a real payment provider. Do not use it to authorize, capture, or reconcile real payments.

```bash
npm install
npm run dev                 # local development → http://localhost:4010
npm run build && npm start  # run the compiled production artifact
```

Copy `.env.example` to `.env` and configure PostgreSQL, `USER_AUTH_SECRET` (at least 32 random bytes), `MOCK_ADMIN_TOKEN`, `MAX_BALANCE`, the provider MSISDN prefixes, and both frontend origin lists. `dotenv` loads `.env` automatically. PostgreSQL is mandatory; startup fails if `DATABASE_URL` is absent or unreachable.

The future User Frontend and Admin Frontend are hosted in separate repositories. Configure their browser origins independently:

```env
USER_FRONTEND_ORIGINS=http://localhost:5175
ADMIN_FRONTEND_ORIGINS=http://localhost:5176
```

Origins accept comma-separated values and trim whitespace. Production requires explicit origins for both frontends and rejects `*`. CORS only controls browser access; authentication uses separate user JWTs and the admin Bearer token. Cookie credentials are disabled.

Local example: Mock Provider `http://localhost:4010`, User Frontend `http://localhost:5175`, Admin Frontend `http://localhost:5176`.
Production example: Mock Provider `https://mock-provider.example.com`, User Frontend `https://mock-user.example.com`, Admin Frontend `https://mock-admin.example.com`.

Production requires a public HTTPS `PUBLIC_BASE_URL` (Vercel's `VERCEL_URL` is a fallback), `USER_AUTH_SECRET`, a `MOCK_ADMIN_TOKEN` of at least 32 bytes, `DATABASE_URL`, both frontend origin variables, MVola/Orange provider credentials, and a non-empty `CALLBACK_ALLOWED_HOSTS` allowlist. `/health` is unauthenticated. Admin `/admin/*` routes require `Authorization: Bearer <MOCK_ADMIN_TOKEN>`; user routes use a distinct JWT. Orange hosted payment uses its `payToken` capability. Build with `npm ci`, run `npm test`, then `npm start`.

## Dynamic account model and admin API

Each user registers one wallet with a provider. The server generates a unique MSISDN from the configured provider prefixes; the frontend cannot choose the MSISDN or initial balance.

User endpoints:

```text
POST /auth/register
POST /auth/login
GET  /account
GET  /account/balance
GET  /account/transactions
POST /account/topup
POST /account/reset
```

After login, send `Authorization: Bearer <USER_ACCESS_TOKEN>`. Account identity comes only from the signed token, and transactions are scoped to that account. Successful top-ups and resets are recorded in the ledger; the top-up limit is configured by `MAX_BALANCE`.

Admin routes are read-only (for the future frontend):

```bash
GET /admin/accounts
GET /admin/accounts/:msisdn
GET /admin/accounts/:msisdn/transactions
```

Registration example:

```bash
curl -X POST http://localhost:4010/auth/register \
  -H "Content-Type: application/json" \
  -d '{"provider":"MVOLA","password":"secret123"}'
```

The Payment Service keeps using the provider routes only (`/token`, `/mvola/*`, `/oauth/v3/token`, `/orange-money-webpay/*`), never `/admin/*`.

## Database schema

The repository includes the final PostgreSQL schema at `database/schema.sql` and versioned migration `database/migrations/001_mock_user_accounts.sql`:

- `mock_accounts` stores provider, generated MSISDN, scrypt password hash, status and balance.
- `mock_transactions` stores account-linked PAYMENT, TOPUP, RESET and REFUND ledger records.

The app applies the migration at startup and does not fall back to in-memory account storage. Provider debits, top-ups and resets lock the account row and write the balance change and ledger record in one PostgreSQL transaction.

---

## Architecture

```text
User Frontend
  │
  │ Browser + CORS (USER_FRONTEND_ORIGINS)
  v
Mock Provider
  ├── /auth/* and /account/*
  └── PostgreSQL (user's account only)

Admin Frontend
  │
  │ Browser + CORS (ADMIN_FRONTEND_ORIGINS) + MOCK_ADMIN_TOKEN
  v
Mock Provider
  └── /admin/* (read-only)

NovaMarket Payment Service
        │
        ├── MVola Adapter ──────→ Mock MVola API         (/token, /mvola/mm/transactions/...)
        │
        └── Orange Adapter ─────→ Mock Orange Money API  (/oauth/v3/token, /orange-money-webpay/...)

Orange WebPay customer ─────────→ Hosted mock checkout   (/__mock/orange/pay/:payToken)
```

```text
src/providers/mvola/         MVola routes/service/types/store   (own error format)
src/providers/orange-money/  Orange routes/service/types/store  (own error format)
src/auth/                    registration, login, scrypt password hashes, signed user JWTs
src/accounts/                authenticated account self-service routes
src/db.ts                    PostgreSQL accounts, ledger, atomic balance operations
src/mock/                    scenarios and /__mock routes
src/shared/                  ids, callback validation, error carriers
```

MVola and Orange Money are **not** merged into one invented API. Each provider plugin is encapsulated and has its own error handler, so errors always have that provider's shape.

**Integration:** the Payment Service keeps `MVolaProvider` and `OrangeMoneyProvider` implementations built for the real APIs. Only configuration changes:

```env
MVOLA_BASE_URL=http://localhost:4010          # prod: https://api.mvola.mg  (sandbox: https://devapi.mvola.mg)
ORANGE_MONEY_BASE_URL=http://localhost:4010   # prod/sandbox: https://api.orange.com
```

---

## Sources and confidence — read this first

I could **not** open the official developer portals directly (`developer.mvola.mg`, `developer.orange.com`). The contracts below are reconstructed from:

- **MVola:** a mirror of the official *"API Merchant Pay v1.0"* PDF (paths, headers, request/response fields, callback samples, HTTP codes, the `900901` fault) cross-checked against several community SDKs (Go, Node, Python, Deno, Dart).
- **Orange Money:** the public **Orange Money WebPay** API as used by community SDKs (`/oauth/v3/token`, `/orange-money-webpay/{dev|country}/v1/webpayment` and `/transactionstatus`, `pay_token`/`notif_token`/`payment_url`, statuses `INITIATED/PENDING/EXPIRED/SUCCESS/FAILED`, the `{code,message,description}` error shape, notification behaviour).

Every item is tagged in this README:

| Tag | Meaning |
|---|---|
| **OFFICIAL** | Taken from the documentation/SDKs above. Still verify against your credentials' portal docs. |
| **ASSUMPTION** | *This behavior is an implementation assumption because the official provider specification was not publicly accessible.* Isolated in the file named. |
| **MOCK-ONLY** | Does not exist in the real provider. |

### Orange Money is redirect-based (important)

The public Orange WebPay API does **not** take the customer's phone number. Your server gets a `pay_token` + `payment_url`, the customer is redirected to Orange's page, chooses/enters their wallet and confirms, then Orange notifies `notif_url`. The mock hosted page lists existing active Orange Money wallets from PostgreSQL; its mock-only confirmation accepts the selected wallet MSISDN:

1. Open the mock hosted page `payment_url` (`/__mock/orange/pay/{pay_token}`) and choose an existing Orange wallet; or
2. `POST /__mock/orange/pay/{pay_token}/confirm` with `{"msisdn":"0321234567"}`.

Your Payment Service keeps calling only the real Orange endpoints.

## Wallet accounts

MSISDN allocation prefixes are backend settings (`MVOLA_MSISDN_PREFIXES` and `ORANGE_MONEY_MSISDN_PREFIXES`). Registration accepts only provider and password; the backend generates the unique phone number and initializes the MGA balance at zero. User passwords are stored as scrypt hashes. The user access token and admin token are independent credentials.

`POST /account/topup` adds an amount to the authenticated wallet; it never accepts a replacement balance. `MAX_BALANCE` caps the resulting balance. `POST /account/reset` sets only the authenticated user's balance to zero. Both operations create account-linked ledger entries. Provider payments debit the matching active wallet and record their result in the same PostgreSQL transaction.

**Simulated outcome:** after the default 1-second settlement delay, an unknown, wrong-provider, blocked or underfunded wallet fails; an eligible payment succeeds with 90% probability and atomically debits its PostgreSQL balance. The remaining 10% fail randomly. Orange uses the same rules after the customer confirms. Scenario controls are internal to the service and have no public HTTP endpoints.

---

## MVola — Merchant Pay v1

Sandbox host `https://devapi.mvola.mg`, production `https://api.mvola.mg`.

### Auth — `POST /token`  (OFFICIAL)
- Headers: `Authorization: Basic base64(consumerKey:consumerSecret)`, `Content-Type: application/x-www-form-urlencoded`
- Body: `grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE`
- Response: `{ "access_token", "scope", "token_type": "Bearer", "expires_in": 3600 }`
- MOCK: development accepts any non-empty key/secret; production requires the configured `MVOLA_CLIENT_KEY` and `MVOLA_CLIENT_SECRET`.
- ASSUMPTION (`mvola.service.ts`): 401/400 error body is a WSO2-style `{error, error_description}`.

### Common headers on all three resources (OFFICIAL)
`Authorization: Bearer <token>`, `Version: 1.0` (`1` also accepted), `X-CorrelationID` (UUID, ≤40), `UserLanguage` (`FR`|`MG`), `UserAccountIdentifier: msisdn;<merchantNumber>`, `partnerName`, `Content-Type: application/json`, `Cache-Control: no-cache`. Optional: `X-Callback-URL` (used by community SDKs; enables callback mode).

### 1. Initiate — `POST /mvola/mm/transactions/type/merchantpay/1.0.0/`  (OFFICIAL; `1.0` also accepted)
Request (all OFFICIAL fields):
```json
{
  "amount": "500", "currency": "Ar", "descriptionText": "...",
  "requestingOrganisationTransactionReference": "order-42",
  "requestDate": "2026-09-29T10:00:00.000Z", "originalTransactionReference": "order-42",
  "debitParty":  [{ "key": "msisdn", "value": "03435000005" }],
  "creditParty": [{ "key": "msisdn", "value": "0343500001" }],
  "metadata": [{ "key": "partnerName", "value": "NovaMarket" }, { "key": "fc", "value": "USD" }, { "key": "amountFc", "value": "1" }]
}
```
Response (OFFICIAL body): `{ "status": "pending", "serverCorrelationId": "<uuid>", "notificationMethod": "callback" | "polling" }`.
- ASSUMPTION: HTTP status is **202**.
- ASSUMPTION: reusing a `requestingOrganisationTransactionReference` → 409 (the PDF lists 409 for conflicting/idempotent requests).

### 2. Status — `GET .../merchantpay/1.0.0/status/{serverCorrelationId}`  (OFFICIAL)
Response: `{ "status": "pending"|"completed"|"failed", "serverCorrelationId", "notificationMethod", "objectReference" }`. `objectReference` is `""` until the transaction settles.
- ASSUMPTION: a `failed` transaction also receives an `objectReference`, so its details can be read.

### 3. Details — `GET .../merchantpay/1.0.0/{transID}`  (OFFICIAL; `transID` = `objectReference`)
Response: `amount, currency, transactionReference, transactionStatus, createDate, debitParty, creditParty, metadata[originalTransactionResult, originalTransactionResultDesc], fees[{feeAmount}]`.
- ASSUMPTION: result codes/descriptions (`0`/`Completed`, `1001`/`Insufficient funds`, `1002`/`Debit account not found`, `1003`/random mock decline) — MVola's result table isn't public. Fee is always `"0"`.

### Callback (OFFICIAL shape)
If `X-Callback-URL` was sent, the mock does `PUT <url>` on settlement (after 1 second by default) with `transactionStatus, serverCorrelationId, transactionReference, requestDate, debitParty, creditParty, metadata` (+ `fees` when completed). The final status is `completed` or `failed`; callback delivery failures are logged and ignored. The payment initiation still returns `pending`.

### Errors
- **OFFICIAL:** invalid/missing token → **401** `{"fault":{"code":900901,"message":"Invalid Credentials","description":"Invalid Credentials. Make sure you have given the correct access token"}}`; HTTP codes 400/401/402/403/404/409/429/5xx as listed in the PDF.
- **ASSUMPTION** (`mvola.types.ts`, single function `mvolaError`): other errors use `{ errorCategory, errorCode, errorDescription, errorDateTime, errorParameters[] }` in **camelCase** (GSMA style). The PDF lists these fields capitalised (`ErrorCategory`…); change the casing in that one function if your real responses differ. Specific `errorCode` values (`formatError`, `notFound`, `duplicateRequest`, `genericError`) are conventions, except `formatError`/`genericError` which appear in GSMA MM API samples.

### Lifecycle
`initiate → pending → (poll status by serverCorrelationId | callback) → completed/failed → objectReference → details`

---

## Orange Money — WebPay

Host `https://api.orange.com`.

### Auth — `POST /oauth/v3/token`  (OFFICIAL)
`Authorization: Basic <authorization header from your Orange app>`, body `grant_type=client_credentials` (form). Response `{ "token_type": "Bearer", "access_token": "...", "expires_in": "7776000" }`. MOCK: development accepts any non-empty Basic value; production requires an exact match to `ORANGE_BASIC_AUTH`. ASSUMPTION: 401 error body.

### 1. Web payment — `POST /orange-money-webpay/{dev|mg}/v1/webpayment`  (OFFICIAL; HTTP 201)
Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept: application/json`.
Request: `merchant_key, currency, order_id, amount (number), return_url, cancel_url, notif_url, lang, reference`.
Response: `{ "status": 201, "message": "OK", "pay_token", "payment_url", "notif_token" }`.
- `dev` = sandbox segment (documented). ASSUMPTION: `mg` is the production segment for Madagascar (`api.orange.com/orange-money-webpay/mg/v1/...`); both accepted. Constant `SUPPORTED_COUNTRY_SEGMENTS` in `orange.service.ts`.
- ASSUMPTION: currency is not validated (sandbox uses `OUV`; Madagascar production value not confirmed — likely `MGA`). `amount` accepts a number or numeric string.
- MOCK-ONLY: `payment_url` points to `/__mock/orange/pay/{pay_token}`.

### 2. Transaction status — `POST /orange-money-webpay/{dev|mg}/v1/transactionstatus`  (OFFICIAL)
Request `{ "order_id", "amount", "pay_token" }` → `{ "status": "INITIATED|PENDING|EXPIRED|SUCCESS|FAILED", "order_id", "txnid"? }` (`txnid` only on success).
Status meaning (OFFICIAL): `INITIATED` waiting for customer; `PENDING` customer pressed *Confirmer*; `SUCCESS`/`FAILED` final; `EXPIRED` confirmed too late. Default `pay_token` validity is **10 minutes** (implemented; an untouched `INITIATED` becomes `EXPIRED`).
- ASSUMPTION: unknown or mismatching order/amount/pay_token → **404** `{code:60,…}`.

### Notification (OFFICIAL, observed)
After the customer confirms, the mock waits 1 second by default, then `POST`s `{ "status", "notif_token", "txnid" }` to `notif_url` (no amount in the payload). The final status is `SUCCESS` or `FAILED`. Your service should verify `notif_token` and confirm via `transactionstatus`.

### Errors
- OFFICIAL shape `{ "code", "message", "description" }`; OFFICIAL example: **400** code `23` "Missing body field" (`Key: 'GetTransactionStatusInfo.OrderId' Error:Field validation …`).
- ASSUMPTION (`orange.types.ts`): struct name `WebPaymentInfo` in the webpayment error text; invalid token = 401 code `41`; provider_error/timeout = 500/504 with that shape.

### Lifecycle
`webpayment → INITIATED → (customer confirms) → PENDING → SUCCESS | FAILED (| EXPIRED) → notif_url + transactionstatus`

---

## Mock-only API — everything under `/__mock`  (MOCK-ONLY)

| Method | Path | Purpose |
|---|---|---|
| GET | `/__mock/orange/pay/:payToken` | Mock hosted payment page |
| POST | `/__mock/orange/pay/:payToken/confirm` | `{ "msisdn": "0321234567" }` — select an existing Orange wallet |

The hosted page is a development simulation, not a real Orange checkout. Its unguessable `payToken` is the capability for viewing and confirming that pending payment.

---

## Windows PowerShell examples (`curl.exe`)

```powershell
$B = "http://localhost:4010"

# Helper: POST JSON without PowerShell quoting problems (no BOM)
function Post-Json($url, $obj, $extra = @()) {
  $f = New-TemporaryFile
  [IO.File]::WriteAllText($f.FullName, ($obj | ConvertTo-Json -Depth 6))
  curl.exe -s -X POST $url -H "Content-Type: application/json" $extra --data-binary "@$($f.FullName)"
  Remove-Item $f
}

# Register a user wallet; the server generates its MSISDN.
$account = Post-Json "$B/auth/register" @{ provider = "MVOLA"; password = "secret123" } | ConvertFrom-Json
$login = Post-Json "$B/auth/login" @{ msisdn = $account.msisdn; password = "secret123" } | ConvertFrom-Json
$UH = @("-H", "Authorization: Bearer $($login.accessToken)")
Post-Json "$B/account/topup" @{ amount = 100000 } $UH
```

**1. Get token (MVola)**
```powershell
$T = (curl.exe -s -X POST "$B/token" -u "myKey:mySecret" -d "grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE" | ConvertFrom-Json).access_token
$H = @("-H","Authorization: Bearer $T","-H","Version: 1.0","-H","X-CorrelationID: $([guid]::NewGuid())",
       "-H","UserLanguage: FR","-H","UserAccountIdentifier: msisdn;0343500001","-H","partnerName: NovaMarket","-H","Cache-Control: no-cache")
```

**2. Initiate MVola payment** (uses the generated MSISDN of the registered MVola wallet)
```powershell
$body = @{
  amount="500"; currency="Ar"; descriptionText="NovaMarket order 42"
  requestingOrganisationTransactionReference="order-42-a1"; originalTransactionReference="order-42-a1"
  requestDate=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  debitParty=@(@{key="msisdn";value=$account.msisdn}); creditParty=@(@{key="msisdn";value="0343500001"})
  metadata=@(@{key="partnerName";value="NovaMarket"})
}
$r = Post-Json "$B/mvola/mm/transactions/type/merchantpay/1.0.0/" $body $H | ConvertFrom-Json
$r
```

**3. Poll MVola status**
```powershell
$s = curl.exe -s $H "$B/mvola/mm/transactions/type/merchantpay/1.0.0/status/$($r.serverCorrelationId)" | ConvertFrom-Json
$s
```

**4. Get MVola transaction details**
```powershell
curl.exe -s $H "$B/mvola/mm/transactions/type/merchantpay/1.0.0/$($s.objectReference)"
```

**5. Initiate Orange Money payment** (token, then WebPay)
```powershell
$orangeAccount = Post-Json "$B/auth/register" @{ provider = "ORANGE_MONEY"; password = "secret123" } | ConvertFrom-Json
$orangeLogin = Post-Json "$B/auth/login" @{ msisdn = $orangeAccount.msisdn; password = "secret123" } | ConvertFrom-Json
$OUH = @("-H", "Authorization: Bearer $($orangeLogin.accessToken)")
Post-Json "$B/account/topup" @{ amount = 100000 } $OUH
$OT = (curl.exe -s -X POST "$B/oauth/v3/token" -H "Authorization: Basic bXlJZDpteVNlY3JldA==" -d "grant_type=client_credentials" | ConvertFrom-Json).access_token
$OH = @("-H","Authorization: Bearer $OT","-H","Accept: application/json")
$w = Post-Json "$B/orange-money-webpay/mg/v1/webpayment" @{
  merchant_key="myMerchantKey"; currency="MGA"; order_id="ORD-42"; amount=2500; lang="fr"
  return_url="http://localhost:3000/return"; cancel_url="http://localhost:3000/cancel"; notif_url="http://localhost:3000/notif"
} $OH | ConvertFrom-Json
$w.payment_url      # open in a browser and pick the wallet...
# ...or simulate the customer without a browser (MOCK-ONLY):
Post-Json "$B/__mock/orange/pay/$($w.pay_token)/confirm" @{ msisdn = $orangeAccount.msisdn }
```

**6. Check Orange Money payment status**
```powershell
Post-Json "$B/orange-money-webpay/mg/v1/transactionstatus" @{ order_id="ORD-42"; amount=2500; pay_token=$w.pay_token } $OH
```

**7. Read and reset the authenticated user's wallet**
```powershell
curl.exe -s "$B/account" -H "Authorization: Bearer $($login.accessToken)"
Post-Json "$B/account/reset" @{} $UH
```

---

## Limitations

- Provider tokens and in-flight payment state are in-memory; persistent wallet balances and ledger records are PostgreSQL-backed.
- User passwords use scrypt and user tokens are signed JWTs; configure strong secrets and use HTTPS outside local development.
- Contract fidelity is limited by what could be verified publicly; see every **ASSUMPTION** above and re-check against your real sandbox credentials before going to production.
