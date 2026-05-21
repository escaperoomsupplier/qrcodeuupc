import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.sqlite');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash        TEXT NOT NULL UNIQUE,
      label             TEXT,
      registered_ip     TEXT,
      created_at        INTEGER NOT NULL,
      last_seen_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS qr_codes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id          INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      slug              TEXT NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      target_label      TEXT NOT NULL DEFAULT 'default',
      action            TEXT NOT NULL DEFAULT 'win',
      single_use        INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds  INTEGER NOT NULL DEFAULT 0,
      used_at           INTEGER,
      last_scan_at      INTEGER,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qr_agent ON qr_codes(agent_id);

    CREATE TABLE IF NOT EXISTS scan_events (
      id            TEXT PRIMARY KEY,
      qr_code_id    INTEGER NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
      agent_id      INTEGER NOT NULL,
      target_label  TEXT NOT NULL,
      action        TEXT NOT NULL,
      ip            TEXT,
      user_agent    TEXT,
      created_at    INTEGER NOT NULL,
      delivered_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_agent_undelivered ON scan_events(agent_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_events_qr ON scan_events(qr_code_id);

    -- rate limit log: 1 row per qr creation
    CREATE TABLE IF NOT EXISTS qr_create_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ip        TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ratelimit_ip_time ON qr_create_log(ip, created_at);
  `);
}
