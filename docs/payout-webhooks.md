# Internal payout callbacks

`POST /internal/payouts` now requires two additional fields:

- `callbackUrl`: the Nova Payment Service callback endpoint.
- `clientPayoutId`: the payout UUID created by Nova Payment Service.

After the mock payout is committed, the provider asynchronously sends a JSON callback containing `payoutId`, `reference`, `provider`, `status`, `failureReason`, `amount`, `currency` and `idempotencyKey`.

The callback includes `X-API-Key` and `Idempotency-Key` headers. The shared provider key authenticates the callback; the receiver must compare it in constant time and process repeated callbacks idempotently. Delivery retries transient failures up to five attempts with exponential backoff. Callback URLs use the existing `isCallbackUrlAllowed` policy, including the production HTTPS host allowlist.

Example callback payload:

```json
{
  "payoutId": "d3b07384-d9a0-4b2e-8c1e-1b7e8c6a5d40",
  "reference": "nova-payout-reference",
  "provider": "MVOLA",
  "status": "COMPLETED",
  "failureReason": null,
  "amount": 2500,
  "currency": "MGA",
  "idempotencyKey": "seller-idempotency-key"
}
```

This callback is a mock-provider integration feature and does not represent an official MVola or Orange Money disbursement webhook.
