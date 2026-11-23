'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// pg returns NUMERIC and BIGINT as strings by default; our values are small, so use numbers.
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

// Grading periods, in display order. `rel` = release flag column on subjects, `col` = grade column on enrollments.
const PERIODS = [
  { key: 'prelim',   label: 'Prelim',     rel: 'rel_prelim',   col: 'prelim'   },
  { key: 'midterm',  label: 'Midterm',    rel: 'rel_midterm',  col: 'midterm'  },
  { key: 'prefinal', label: 'Pre Finals', rel: 'rel_prefinal', col: 'prefinal' },
  { key: 'finals',   label: 'Finals',     rel: 'rel_finals',   col: 'finals'   },
];

const MIGRATION_LOCK = 727274;   // arbitrary constant: stops two app instances migrating at once

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const dir = path.join(__dirname, '..', 'migrations');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration ${file}`);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

// Connection settings come from DATABASE_URL, or the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.
// `schema` (tests only) isolates a run inside its own Postgres schema.
async function openDb({ connectionString, schema } = {}) {
  const cfg = { max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
  if (connectionString) cfg.connectionString = connectionString;
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid schema name');
    const boot = new Pool(cfg);
    await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await boot.end();
    cfg.options = `-c search_path=${schema}`;
  }
  const pool = new Pool(cfg);
  pool.on('error', err => console.error('Postgres pool error:', err.message));

  const wrap = (exec) => ({
    query: (text, params) => exec.query(text, params),
    one: async (text, params) => (await exec.query(text, params)).rows[0],
    all: async (text, params) => (await exec.query(text, params)).rows,
  });
  const db = {
    ...wrap(pool),
    // Run fn inside a transaction; throwing (or returning a rejected promise) rolls everything back.
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    },
    dropSchema: async () => {
      if (!schema) return;
      const tmp = new Pool({ connectionString: cfg.connectionString });
      try { await tmp.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await tmp.end(); }
    },
    close: () => pool.end(),
  };
  await migrate(pool);
  return db;
}

const isUniqueViolation = e => e && e.code === '23505';

module.exports = { openDb, PERIODS, isUniqueViolation };
