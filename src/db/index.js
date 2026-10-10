// One small database layer for two engines:
//   PostgreSQL (production, when DATABASE_URL is set) and SQLite (local development / demos).
// Write SQL with $1, $2 ... placeholders; it works on both.
// Conventions so both engines behave the same: ids are TEXT (uuid), timestamps are ISO TEXT,
// booleans are INTEGER 0/1, JSON is stored as TEXT (use j() / pj()).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

let engine = null; // 'pg' | 'sqlite'
let pool = null;   // pg pool
let lite = null;   // sqlite db

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const j = (v) => JSON.stringify(v ?? null);
export function pj(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
export const dbEngine = () => engine;

function normParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export async function initDb() {
  if (engine) return;
  if (config.databaseUrl) {
    let pg;
    try { pg = (await import('pg')).default; } catch {
      throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install');
    }
    const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
    const ssl = config.databaseSsl === 'false' ? false
      : config.databaseSsl === 'true' || !local ? { rejectUnauthorized: false } : false;
    pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 10, idleTimeoutMillis: 30000 });
    await pool.query('SELECT 1');
    engine = 'pg';
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.resolve(config.sqliteFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lite = new DatabaseSync(file);
    lite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    engine = 'sqlite';
    if (config.production) console.warn('[db] WARNING: running on SQLite. Set DATABASE_URL (PostgreSQL) for real customers.');
  }
  console.log(`[db] connected (${engine})`);
}

function liteRun(sql, params) {
  const stmt = lite.prepare(sql.replace(/\$(\d+)/g, '?$1'));
  const p = params.map(normParam);
  if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
    const rows = stmt.all(...p).map((r) => ({ ...r }));
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...p);
  return { rows: [], rowCount: Number(info.changes || 0) };
}

function makeApi(exec) {
  return {
    async query(sql, params = []) { return (await exec(sql, params)).rows; },
    async one(sql, params = []) { return (await exec(sql, params)).rows[0] || null; },
    async run(sql, params = []) { return (await exec(sql, params)).rowCount; },
    async value(sql, params = []) { const r = (await exec(sql, params)).rows[0]; return r ? Object.values(r)[0] : null; },
  };
}

const execTop = async (sql, params) => {
  if (engine === 'pg') { const r = await pool.query(sql, params.map(normParam)); return { rows: r.rows, rowCount: r.rowCount }; }
  return liteRun(sql, params);
};

export const db = {
  ...makeApi(execTop),
  // Run several statements atomically. fn receives an object with the same query/one/run/value methods.
  async tx(fn) {
    if (engine === 'pg') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const api = makeApi(async (sql, params) => { const r = await client.query(sql, params.map(normParam)); return { rows: r.rows, rowCount: r.rowCount }; });
        const out = await fn(api);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    }
    // node:sqlite is synchronous, so nothing else can interleave between BEGIN and COMMIT except our own awaits.
    lite.exec('BEGIN');
    try {
      const out = await fn(makeApi(async (sql, params) => liteRun(sql, params)));
      lite.exec('COMMIT');
      return out;
    } catch (e) { try { lite.exec('ROLLBACK'); } catch {} throw e; }
  },
  async exec(script) {
    if (engine === 'pg') return pool.query(script);
    return lite.exec(script);
  },
};

// Simple key/value store (platform settings, generated secrets)
export async function kvGet(k) { return db.value('SELECT v FROM kv WHERE k = $1', [k]); }
export async function kvSet(k, v) {
  await db.run('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}
