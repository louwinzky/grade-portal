-- Identity is case-sensitive: PROF and prof are different usernames / student numbers.
-- Existing databases must not contain two IDs differing only by case before this runs.
DROP INDEX IF EXISTS users_username_uq;
CREATE UNIQUE INDEX users_username_uq ON users (username);

DROP INDEX IF EXISTS students_no_uq;
CREATE UNIQUE INDEX students_no_uq ON students (student_no);
