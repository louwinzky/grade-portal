-- Instructor account management. Owners can create/reset/disable other instructors in the app.
ALTER TABLE users ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN active   BOOLEAN NOT NULL DEFAULT true;

-- Upgrades: if nobody owns the portal yet, hand ownership to the oldest teacher.
UPDATE users SET is_owner = true
WHERE id = (SELECT id FROM users WHERE role = 'teacher' ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'teacher' AND is_owner);

CREATE INDEX users_teacher_active_idx ON users (role, active);
