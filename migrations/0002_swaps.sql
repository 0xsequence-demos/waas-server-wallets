CREATE TABLE swap_summaries (
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  phase TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY(wallet_id, id)
);
CREATE INDEX swap_summaries_history ON swap_summaries(wallet_id, updated_at DESC, id);
-- Node's authoritative journal; Workers use the same schema inside each wallet DO.
CREATE TABLE swap_authority (
  namespace TEXT NOT NULL, id TEXT NOT NULL, intent_id TEXT NOT NULL, wallet_id TEXT NOT NULL, subject TEXT NOT NULL,
  version INTEGER NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL,
  next_at INTEGER, active INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1,
  value TEXT NOT NULL,
  PRIMARY KEY(namespace, id), UNIQUE(namespace, intent_id)
);
CREATE INDEX swap_authority_due ON swap_authority(next_at, dirty);
CREATE TABLE swap_quote_limits (wallet_id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
