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
