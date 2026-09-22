CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT UNIQUE NOT NULL,
    name TEXT,
    phone TEXT,
    photo_file_id TEXT,
    photo_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_states (
    chat_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'IDLE',
    temp_name TEXT,
    temp_phone TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_chat_id
ON users(chat_id);
