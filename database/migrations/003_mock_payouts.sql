ALTER TABLE mock_transactions DROP CONSTRAINT IF EXISTS mock_transactions_type_check;
ALTER TABLE mock_transactions ADD CONSTRAINT mock_transactions_type_check
  CHECK (type IN ('PAYMENT', 'TOPUP', 'RESET', 'REFUND', 'PAYOUT_SENT', 'PAYOUT_RECEIVED'));

CREATE TABLE IF NOT EXISTS mock_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('MVOLA', 'ORANGE_MONEY')),
  sender_account_id UUID NOT NULL REFERENCES mock_accounts(id),
  recipient_account_id UUID NOT NULL REFERENCES mock_accounts(id),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'MGA',
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  failure_reason TEXT,
  sender_balance_before NUMERIC(18, 2) NOT NULL,
  sender_balance_after NUMERIC(18, 2) NOT NULL,
  recipient_balance_before NUMERIC(18, 2) NOT NULL,
  recipient_balance_after NUMERIC(18, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mock_payouts_sender_created ON mock_payouts(sender_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mock_payouts_recipient_created ON mock_payouts(recipient_account_id, created_at DESC);
