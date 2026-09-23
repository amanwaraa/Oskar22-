CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  company_name TEXT,
  account_id TEXT,
  account_name TEXT,
  account_role TEXT,
  payload_json TEXT NOT NULL,
  logged_in_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  invoice_cursor INTEGER NOT NULL DEFAULT 0,
  purchase_cursor INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'verified',
  verification_message TEXT,
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_states (
  chat_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'IDLE',
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  delivery_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_sessions_company ON telegram_sessions(company_id,active);
CREATE INDEX IF NOT EXISTS idx_tg_sessions_account ON telegram_sessions(company_id,account_id,active);
CREATE INDEX IF NOT EXISTS idx_tg_deliveries_chat ON telegram_deliveries(chat_id,sent_at);
