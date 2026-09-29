CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mock_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('MVOLA', 'ORANGE_MONEY')),
  msisdn TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  balance NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency TEXT NOT NULL DEFAULT 'MGA',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mock_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES mock_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('MVOLA', 'ORANGE_MONEY')),
  type TEXT NOT NULL CHECK (type IN ('PAYMENT', 'TOPUP', 'RESET', 'REFUND')),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'MGA',
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  reference TEXT NOT NULL,
  balance_before NUMERIC(18, 2) NOT NULL CHECK (balance_before >= 0),
  balance_after NUMERIC(18, 2) NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_accounts_provider_created
  ON mock_accounts (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mock_transactions_account_created
  ON mock_transactions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mock_transactions_reference
  ON mock_transactions (reference);