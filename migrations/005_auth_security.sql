-- Instructor security: TOTP second factor, one-time recovery codes, and email recovery tokens.
-- Students intentionally have no email/2FA fields: their accounts remain teacher-managed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_totp_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS recovery_codes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  requested_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets (expires_at);

-- Pending login challenges: a correct password creates one of these instead of a normal session.
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx ON login_challenges (expires_at);
