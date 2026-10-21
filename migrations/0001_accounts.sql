CREATE TABLE titoja_users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 5 AND 254 AND email = lower(email)),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE titoja_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES titoja_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('client', 'courier', 'establishment', 'driver')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  establishment_name TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (role = 'establishment' AND establishment_name IS NOT NULL AND length(establishment_name) BETWEEN 2 AND 100)
    OR (role <> 'establishment' AND establishment_name IS NULL)
  )
);

CREATE TABLE titoja_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES titoja_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX titoja_sessions_user ON titoja_sessions(user_id, created_at);
CREATE INDEX titoja_sessions_expiry ON titoja_sessions(expires_at);
