// prospecting/migrate.js — ordered, run-once SQL migrations for the px_* schema
//
// Files in ./migrations named NNN_name.sql run in order, each inside its own
// transaction, and are recorded in px_schema_migrations with a checksum. A file
// that was already applied is skipped; a file whose contents changed after it was
// applied is refused (write a new migration instead of editing an old one).
// A Postgres advisory lock keeps two booting instances from migrating at once.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 727274001; // arbitrary, unique to the prospecting schema

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(function (f) { return /^\d{3}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql'); })
    .sort();
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function migrate(pool, log) {
  log = log || console.log;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS px_schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const done = new Map(
      (await client.query('SELECT name, checksum FROM px_schema_migrations')).rows
        .map(function (r) { return [r.name, r.checksum]; })
    );

    const applied = [];
    for (const file of listMigrations()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksum(sql);
      if (done.has(file)) {
        if (done.get(file) !== sum) {
          throw new Error('Migration ' + file + ' was edited after it was applied. Add a new migration instead.');
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO px_schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        throw new Error('Migration ' + file + ' failed and was rolled back: ' + e.message);
      }
      applied.push(file);
      log('Prospecting: applied migration ' + file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(function () {});
    client.release();
  }
}

// Reverses one migration using its .down.sql file. Operator-only.
async function rollback(pool, name) {
  const downFile = path.join(MIGRATIONS_DIR, name.replace(/\.sql$/, '.down.sql'));
  if (!fs.existsSync(downFile)) throw new Error('No down migration for ' + name);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('BEGIN');
    await client.query(fs.readFileSync(downFile, 'utf8'));
    await client.query('DELETE FROM px_schema_migrations WHERE name = $1', [name]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(function () {});
    client.release();
  }
}

module.exports = { migrate, rollback, listMigrations };
