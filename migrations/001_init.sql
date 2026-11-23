-- Grade Portal schema. Applied once, in order, by src/db.js (tracked in schema_migrations).

CREATE TABLE students (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_no TEXT NOT NULL,
  full_name  TEXT NOT NULL
);
CREATE UNIQUE INDEX students_no_uq ON students (lower(student_no));

CREATE TABLE users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher','student')),
  full_name TEXT NOT NULL,
  student_id INTEGER UNIQUE REFERENCES students(id) ON DELETE CASCADE,   -- at most one account per student
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

CREATE TABLE subjects (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  term TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  rel_prelim   BOOLEAN NOT NULL DEFAULT false,   -- release switches: students see a period only when true
  rel_midterm  BOOLEAN NOT NULL DEFAULT false,
  rel_prefinal BOOLEAN NOT NULL DEFAULT false,
  rel_finals   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, code, term, section)
);

CREATE TABLE enrollments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  prelim   NUMERIC(5,2) CHECK (prelim   BETWEEN 0 AND 100),
  midterm  NUMERIC(5,2) CHECK (midterm  BETWEEN 0 AND 100),
  prefinal NUMERIC(5,2) CHECK (prefinal BETWEEN 0 AND 100),
  finals   NUMERIC(5,2) CHECK (finals   BETWEEN 0 AND 100),
  final_pct NUMERIC(5,2) CHECK (final_pct BETWEEN 0 AND 100),   -- teacher view only, never sent to students
  final_gp  NUMERIC(3,2) CHECK (final_gp BETWEEN 1 AND 5),      -- final grade on the 1.00-5.00 scale
  remark TEXT CHECK (remark IN ('Passed','Failed','Dropped')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, student_id)
);
CREATE INDEX enrollments_student_idx ON enrollments (student_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER,            -- no foreign key: the log outlives deleted accounts
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX audit_user_idx ON audit_log (user_id, id DESC);
