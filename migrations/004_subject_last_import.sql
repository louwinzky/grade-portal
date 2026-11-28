-- Last successful Registrar Report import per subject, for the instructor overview.
ALTER TABLE subjects ADD COLUMN last_import_at TIMESTAMPTZ;
