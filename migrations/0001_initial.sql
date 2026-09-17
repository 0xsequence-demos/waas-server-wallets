CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  identifier TEXT NOT NULL,
  name TEXT NOT NULL,
  snapshot TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(scope, identifier)
);
CREATE INDEX wallets_scope ON wallets(scope, created_at DESC, id);
CREATE TABLE operations (
  id TEXT NOT NULL,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  kind TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(wallet_id, id)
);
CREATE TABLE admin_sessions (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE audit_events (id TEXT PRIMARY KEY, wallet_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE local_wallet_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key));
