# mock-mobile-money-service

A fake **MVola** and **Orange Money** provider for local development and testing of the NovaMarket Payment Service.

- Node.js ≥ 20, TypeScript, Fastify, REST
- **No database or real provider calls** — all state is in memory; configured callbacks are outbound HTTP requests
- **All state is lost when the process restarts** (transactions, tokens, balances, config)

> This is a development/test simulator, not a real payment provider. Authentication is simulated and transaction
> state is volatile; do not use it to authorize, capture, or reconcile real payments.

```bash
npm install
npm run dev                 # local development → http://localhost:4010
npm run build && npm start  # run the compiled production artifact
```

Environment variables: `PORT` (default `4010`), `HOST` (default `0.0.0.0`), `PUBLIC_BASE_URL` (default `http://localhost:<PORT>`, used to build Orange's `payment_url`), `LOG_LEVEL`.

Production-like deployment requires `NODE_ENV=production`, a public HTTPS `PUBLIC_BASE_URL` (Vercel's `VERCEL_URL` is
used as a fallback), a `MOCK_ADMIN_TOKEN` of at least 32 bytes, `MVOLA_CLIENT_KEY`, `MVOLA_CLIENT_SECRET`,
`ORANGE_BASIC_AUTH` (the full `Basic <base64>` value), and a comma-separated `CALLBACK_ALLOWED_HOSTS` hostname allowlist.
`/health` is unauthenticated for health probes. Administrative `/__mock`
routes require `Authorization: Bearer <MOCK_ADMIN_TOKEN>`; the Orange hosted payment and confirmation routes use the
unguessable `payToken` capability instead. Production callbacks must use HTTPS to an allowlisted hostname; redirects
are rejected and callback requests time out after 5 seconds. Build in CI with `npm ci`, then run `npm test` and
`npm start` with production dependencies only.

---

## Architecture

```text
NovaMarket Payment Service
        │
        ├── MVola Adapter ──────→ Mock MVola API         (/token, /mvola/mm/transactions/...)
        │
        └── Orange Adapter ─────→ Mock Orange Money API  (/oauth/v3/token, /orange-money-webpay/...)

Test tooling ───────────────────→ Mock-only API          (/__mock/*)
```

```text
src/providers/mvola/         MVola routes/service/types/store   (own error format)
src/providers/orange-money/  Orange routes/service/types/store  (own error format)
src/mock/                    profiles.ts (the 10 profiles), config, /__mock routes
src/shared/                  ids + error carriers
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

The public Orange WebPay API does **not** take the customer's phone number. Your server gets a `pay_token` + `payment_url`, the customer is redirected to Orange's page, chooses/enters their wallet and confirms, then Orange notifies `notif_url`. So a "fake profile" cannot be selected through the provider API. The mock adds **MOCK-ONLY** ways to pick one:

1. Open the mock hosted page `payment_url` (`/__mock/orange/pay/{pay_token}`) and click a profile; or
2. `POST /__mock/orange/pay/{pay_token}/confirm` with `{"profile":"ORANGE_MONEY_5"}`; or
3. Set `orangeAutoProfile` via `/__mock/config` — every WebPay payment is auto-confirmed with that profile.

Your Payment Service keeps calling only the real Orange endpoints.

---

## Profiles (`src/mock/profiles.ts` — edit the array to change them)

| Profile | Fake MSISDN | Initial balance |
|---|---|---|
| MVOLA_1..5 | 03435000001..05 | 1 000 / 5 000 / 10 000 / 100 000 / 1 000 000 Ar |
| ORANGE_MONEY_1..5 | 03200000001..05 | 1 000 / 5 000 / 10 000 / 100 000 / 1 000 000 Ar |

- **Fake number ≠ user number.** The user's real number stays in User Service. The Payment Service maps the chosen profile to `fakeMsisdn` and sends that to MVola as `debitParty`. Many users can share a profile; no per-user accounts exist.
- **Balance:** a completed payment lowers `balance`; `initialBalance` never changes. `reset` restores `balance = initialBalance`. Balances are per profile, so users sharing a profile share the balance.
- **No arbitrary balances:** there is deliberately no endpoint to set a custom balance. To "top up", reset the profile.
- **Not coupled to the Payment Service's own balance** — the mock only represents the external provider.

**Simulated outcome** (scenario `success`): after the default 1-second settlement delay, an unknown MVola debit MSISDN or insufficient balance fails; an eligible payment succeeds with 90% probability and debits the profile balance. The remaining 10% fail randomly. Orange uses the same rule after the customer confirms.

---

## Scenarios (mock-only, `POST /__mock/config`)

| `scenario` | Effect (provider contract unchanged) |
|---|---|
| `success` (default) | Eligible payments settle after `settleDelayMs` (default 1000 ms): 90% succeed and debit the profile balance; 10% fail randomly. Unknown accounts and insufficient balances always fail. |
| `insufficient_balance` | Every payment fails |
| `provider_error` | Initiation returns 5xx (MVola: 503 error object; Orange: 500 `{code,message,description}`) |
| `timeout` | Initiation hangs `timeoutMs` (default 30 000) then returns 504 |
| `always_pending` | Payments never settle (MVola stays `pending`; Orange stays `INITIATED`, or `PENDING` once confirmed) |

Other config fields: `settleDelayMs` (default 1000 ms), `timeoutMs`, `orangeAutoProfile` (`null` or `ORANGE_MONEY_n`).

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
| GET | `/__mock/profiles` | List the 10 profiles |
| GET | `/__mock/profiles/:profile` | One profile |
| POST | `/__mock/profiles/:profile/reset` | `balance = initialBalance` |
| POST | `/__mock/reset` | Reset all 10 (`?transactions=true` also clears transactions; `?config=true` restores default config) |
| GET / POST | `/__mock/config` | Read / update scenario config |
| GET | `/__mock/transactions` | Inspect in-memory transactions (both providers) |
| GET | `/__mock/orange/pay/:payToken` | Mock hosted payment page |
| POST | `/__mock/orange/pay/:payToken/confirm` | `{ "profile": "ORANGE_MONEY_n" }` — simulate the customer paying |

Send **no** `Content-Type` on body-less POSTs (reset). Errors here are `{ "error": "MOCK_ERROR", "message": "..." }`.

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
```

**1. Get token (MVola)**
```powershell
$T = (curl.exe -s -X POST "$B/token" -u "myKey:mySecret" -d "grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE" | ConvertFrom-Json).access_token
$H = @("-H","Authorization: Bearer $T","-H","Version: 1.0","-H","X-CorrelationID: $([guid]::NewGuid())",
       "-H","UserLanguage: FR","-H","UserAccountIdentifier: msisdn;0343500001","-H","partnerName: NovaMarket","-H","Cache-Control: no-cache")
```

**2. Initiate MVola payment** (`03435000005` = fake number of profile MVOLA_5)
```powershell
$body = @{
  amount="500"; currency="Ar"; descriptionText="NovaMarket order 42"
  requestingOrganisationTransactionReference="order-42-a1"; originalTransactionReference="order-42-a1"
  requestDate=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  debitParty=@(@{key="msisdn";value="03435000005"}); creditParty=@(@{key="msisdn";value="0343500001"})
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
$OT = (curl.exe -s -X POST "$B/oauth/v3/token" -H "Authorization: Basic bXlJZDpteVNlY3JldA==" -d "grant_type=client_credentials" | ConvertFrom-Json).access_token
$OH = @("-H","Authorization: Bearer $OT","-H","Accept: application/json")
$w = Post-Json "$B/orange-money-webpay/mg/v1/webpayment" @{
  merchant_key="myMerchantKey"; currency="MGA"; order_id="ORD-42"; amount=2500; lang="fr"
  return_url="http://localhost:3000/return"; cancel_url="http://localhost:3000/cancel"; notif_url="http://localhost:3000/notif"
} $OH | ConvertFrom-Json
$w.payment_url      # open in a browser and pick a profile...
# ...or simulate the customer without a browser (MOCK-ONLY):
Post-Json "$B/__mock/orange/pay/$($w.pay_token)/confirm" @{ profile = "ORANGE_MONEY_5" }
```

**6. Check Orange Money payment status**
```powershell
Post-Json "$B/orange-money-webpay/mg/v1/transactionstatus" @{ order_id="ORD-42"; amount=2500; pay_token=$w.pay_token } $OH
```

**7. Inspect mock profiles**
```powershell
curl.exe -s "$B/__mock/profiles"
curl.exe -s "$B/__mock/profiles/MVOLA_5"
```

**8. Reset a profile**
```powershell
curl.exe -s -X POST "$B/__mock/profiles/MVOLA_5/reset"
```

**9. Reset all profiles** (optionally also transactions and config)
```powershell
curl.exe -s -X POST "$B/__mock/reset"
curl.exe -s -X POST "$B/__mock/reset?transactions=true&config=true"
```

**10. Configure scenarios**
```powershell
Post-Json "$B/__mock/config" @{ scenario = "insufficient_balance" }
Post-Json "$B/__mock/config" @{ scenario = "always_pending" }
Post-Json "$B/__mock/config" @{ scenario = "success"; settleDelayMs = 500; orangeAutoProfile = "ORANGE_MONEY_5" }
```

---

## Limitations

- In-memory only; restart = clean slate. Single process, no persistence, no concurrency guarantees beyond Node's event loop.
- Not a security tool: authentication is intentionally fake.
- Contract fidelity is limited by what could be verified publicly; see every **ASSUMPTION** above and re-check against your real sandbox credentials before going to production.
