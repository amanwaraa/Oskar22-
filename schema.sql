CREATE TABLE IF NOT EXISTS store_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  store_name TEXT NOT NULL DEFAULT 'متجر أوسكار البرمجي',
  welcome_text TEXT NOT NULL DEFAULT 'اختر البرنامج المناسب لك وادفع بالطريقة التي تناسبك، ثم أرسل إثبات الدفع وسيتم مراجعة طلبك.',
  support_username TEXT NOT NULL DEFAULT 'PUPGG_PAY',
  owner_username TEXT NOT NULL DEFAULT 'PUPGG_PAY',
  owner_chat_id TEXT,
  banner_file_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '₪',
  photo_file_id TEXT,
  delivery_text TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  photo_file_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_orders (
  id TEXT PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  user_chat_id TEXT NOT NULL,
  username TEXT,
  customer_name TEXT,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  payment_method_id TEXT NOT NULL,
  payment_method_name TEXT NOT NULL,
  proof_type TEXT,
  proof_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_states (
  chat_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'IDLE',
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_orders_user ON store_orders(user_chat_id,created_at);
CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(status,created_at);
CREATE INDEX IF NOT EXISTS idx_store_products_active ON store_products(active,sort_order);
CREATE INDEX IF NOT EXISTS idx_store_payments_active ON store_payment_methods(active,sort_order);

-- Oscar Cashier SaaS v5
CREATE TABLE IF NOT EXISTS saas_accounts (
  id TEXT PRIMARY KEY,
  owner_chat_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  company_name TEXT NOT NULL,
  telegram_username TEXT,
  status TEXT NOT NULL DEFAULT 'trial',
  trial_started_at TEXT NOT NULL,
  trial_ends_at TEXT NOT NULL,
  subscription_ends_at TEXT,
  current_plan_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saas_sessions (chat_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, logged_in_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saas_plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, days INTEGER NOT NULL, price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT '₪', active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saas_subscription_orders (
  id TEXT PRIMARY KEY, order_code TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL,
  user_chat_id TEXT NOT NULL, username TEXT, customer_name TEXT,
  plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, plan_days INTEGER NOT NULL,
  price REAL NOT NULL, currency TEXT NOT NULL, payment_method_id TEXT NOT NULL,
  payment_method_name TEXT NOT NULL, proof_type TEXT, proof_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', admin_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_products (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, sku TEXT,
  sale_price REAL NOT NULL DEFAULT 0, avg_cost REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'حبة', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_customers (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
  balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_suppliers (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
  balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_sales (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, invoice_no TEXT NOT NULL,
  customer_id TEXT, customer_name TEXT NOT NULL, total REAL NOT NULL,
  paid REAL NOT NULL, remaining REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_sale_items (
  id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, account_id TEXT NOT NULL,
  product_id TEXT NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL,
  unit_price REAL NOT NULL, total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_purchases (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, purchase_no TEXT NOT NULL,
  supplier_id TEXT, supplier_name TEXT NOT NULL, total REAL NOT NULL,
  paid REAL NOT NULL, remaining REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_purchase_items (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, account_id TEXT NOT NULL,
  product_id TEXT NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL,
  unit_cost REAL NOT NULL, total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_expenses (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, category TEXT NOT NULL,
  note TEXT, amount REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pos_cash_moves (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
  amount REAL NOT NULL, ref_id TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_orders_status ON saas_subscription_orders(status,created_at);
CREATE INDEX IF NOT EXISTS idx_pos_products_account ON pos_products(account_id,name);
CREATE INDEX IF NOT EXISTS idx_pos_sales_account ON pos_sales(account_id,created_at);
CREATE INDEX IF NOT EXISTS idx_pos_purchases_account ON pos_purchases(account_id,created_at);
