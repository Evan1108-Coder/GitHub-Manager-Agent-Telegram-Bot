const { DatabaseSync } = require('node:sqlite');
const { getConfig } = require('./config');

let db;

function openDb(dbPath = getConfig().dbPath) {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kind, key)
    );

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      output_style TEXT NOT NULL DEFAULT 'concise',
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      status TEXT NOT NULL,
      message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      FOREIGN KEY(job_id) REFERENCES scheduled_jobs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      action_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      telegram_file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      extracted_text TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    );
  `);
}

function recordTelemetry({ chatId = null, kind, label, status, durationMs, detail = '' }) {
  openDb().prepare(`
    INSERT INTO telemetry (chat_id, kind, label, status, duration_ms, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chatId === null ? null : String(chatId), kind, label, status, Math.round(durationMs), String(detail).slice(0, 1000));
}

function getSetting(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  openDb().prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}

function addConversation(chatId, role, content) {
  openDb().prepare('INSERT INTO conversations (chat_id, role, content) VALUES (?, ?, ?)').run(String(chatId), role, String(content).slice(0, 8000));
  openDb().prepare(`
    DELETE FROM conversations
    WHERE rowid IN (
      SELECT rowid FROM conversations
      WHERE chat_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT -1 OFFSET 40
    )
  `).run(String(chatId));
}

function getConversation(chatId, limit = 12) {
  return openDb().prepare(`
    SELECT role, content, created_at
    FROM conversations
    WHERE chat_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(String(chatId), limit).reverse();
}

module.exports = {
  openDb,
  getSetting,
  setSetting,
  addConversation,
  getConversation,
  recordTelemetry,
};
