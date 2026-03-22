// Core database module — SQLite + sqlite-vec + config
// Foundation for all hooks and analysis pipelines

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

// --- Constants ---

export const GLOBAL_DIR = join(process.env.HOME || '', '.reflexion-fusion');
export const DATA_DIR = join(GLOBAL_DIR, 'data');
export const DB_PATH = join(DATA_DIR, 'reflexion-fusion.db');
export const CONFIG_PATH = join(GLOBAL_DIR, 'config.json');
export const GENERATED_DIR = join(GLOBAL_DIR, 'generated');
export const LOCK_PATH = join(GLOBAL_DIR, '.analysis.lock');
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const DEFAULT_SOCKET_PATH = '/tmp/reflexion-fusion-embed.sock';
export const RETENTION_DAYS = 90;
export const EVALUATION_RETENTION_DAYS = 180;
export const EMBEDDING_DIM = 384;

// --- Config ---

export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function saveConfig(config) {
  ensureDir(GLOBAL_DIR);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function isEnabled() {
  const config = loadConfig();
  return config.enabled !== false;
}

// --- Directory helpers ---

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// --- Database singleton ---

let _db = null;

export function getDb() {
  if (_db) return _db;

  ensureDir(DATA_DIR);
  ensureDir(GENERATED_DIR);

  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH);

  // Load sqlite-vec extension
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(_db);
  } catch {
    // sqlite-vec not available — vector search will be disabled
  }

  // Pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');

  initDb(_db);
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// --- Schema initialization ---

export function initDb(db) {
  db.exec(`
    -- Core events table
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      v INTEGER DEFAULT 1,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT,
      project_path TEXT,
      data JSON NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_path, type, ts);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);

    -- Error knowledge base
    CREATE TABLE IF NOT EXISTS error_kb (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      error_normalized TEXT NOT NULL UNIQUE,
      error_raw TEXT,
      resolution TEXT,
      resolved_by TEXT,
      tool_sequence TEXT,
      use_count INTEGER DEFAULT 0,
      last_used TEXT
    );

    -- Feedback tracking
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      v INTEGER DEFAULT 1,
      ts TEXT NOT NULL,
      suggestion_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('accepted','rejected','dismissed')),
      suggestion_type TEXT,
      summary TEXT
    );

    -- AI analysis cache
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      project TEXT,
      days INTEGER,
      input_hash TEXT,
      analysis JSON NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_cache_key
      ON analysis_cache(project, days, input_hash);

    -- Skill embeddings
    CREATE TABLE IF NOT EXISTS skill_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      description TEXT,
      keywords TEXT,
      updated_at TEXT NOT NULL
    );

    -- Evaluation results
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      v INTEGER DEFAULT 1,
      ts TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      suggestion_id TEXT,
      project_path TEXT,
      status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','validating','grading','comparing','analyzing','complete','failed')),
      validation JSON,
      grading JSON,
      comparison JSON,
      analysis JSON,
      overall_verdict TEXT CHECK(overall_verdict IS NULL OR overall_verdict IN ('pass','fail','improve')),
      iteration INTEGER DEFAULT 1,
      deployed_at TEXT,
      error_message TEXT
    );

    -- Generated skills history
    CREATE TABLE IF NOT EXISTS generated_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      v INTEGER DEFAULT 1,
      ts TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      suggestion_id TEXT,
      project_path TEXT,
      file_path TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      source_patterns JSON,
      evaluation_id INTEGER REFERENCES evaluations(id),
      approved INTEGER DEFAULT 0,
      deployed INTEGER DEFAULT 0,
      deployed_path TEXT
    );
  `);

  // FTS5 index (ignore if already exists)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
        USING fts5(type, text, content='events', content_rowid='id');
    `);
  } catch { /* FTS5 may already exist or not be available */ }

  // Vector tables (ignore if sqlite-vec not loaded)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_error_kb
        USING vec0(error_kb_id INTEGER PRIMARY KEY, embedding float[${EMBEDDING_DIM}]);
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_skill_embeddings
        USING vec0(skill_id INTEGER PRIMARY KEY, embedding float[${EMBEDDING_DIM}]);
    `);
  } catch { /* sqlite-vec not available */ }

  // FTS triggers
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events
      WHEN NEW.type IN ('prompt', 'tool_error')
      BEGIN
        INSERT INTO events_fts(rowid, type, text)
        VALUES (NEW.id, NEW.type, COALESCE(json_extract(NEW.data, '$.text'), json_extract(NEW.data, '$.error')));
      END;
    `);
  } catch { /* ignore */ }
}

// --- CRUD operations ---

export function insertEvent(entry) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO events (v, type, ts, session_id, project, project_path, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    entry.v || 1,
    entry.type,
    entry.ts || new Date().toISOString(),
    entry.sessionId || entry.session_id || '',
    entry.project || null,
    entry.projectPath || entry.project_path || null,
    JSON.stringify(entry.data || entry)
  );
}

export function queryEvents(filters = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.projectPath) {
    conditions.push('project_path = ?');
    params.push(filters.projectPath);
  }
  if (filters.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters.since) {
    conditions.push('ts >= ?');
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ? `LIMIT ${Number(filters.limit)}` : '';
  const order = 'ORDER BY ts DESC';

  const sql = `SELECT * FROM events ${where} ${order} ${limit}`;
  return db.prepare(sql).all(...params);
}

export function getSessionEvents(sessionId, limit = 100) {
  return queryEvents({ sessionId, limit });
}

// --- Vector search ---

export function vectorSearch(table, vecTable, embedding, limit = 5) {
  const db = getDb();
  const fkColumn = table === 'error_kb' ? 'error_kb_id' : 'skill_id';

  try {
    const vecResults = db.prepare(`
      SELECT ${fkColumn} as id, distance
      FROM ${vecTable}
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(new Float32Array(embedding), limit);

    if (!vecResults.length) return [];

    const ids = vecResults.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...ids);

    // Merge distance info
    const distanceMap = new Map(vecResults.map(r => [r.id, r.distance]));
    return rows.map(row => ({
      ...row,
      distance: distanceMap.get(row.id) || 1.0,
    })).sort((a, b) => a.distance - b.distance);
  } catch {
    return []; // sqlite-vec not available
  }
}

// --- Embedding generation (via client) ---

let _embedClient = null;

export async function generateEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];
  try {
    if (!_embedClient) {
      const { embedViaServer } = await import('./embedding-client.mjs');
      _embedClient = embedViaServer;
    }
    return await _embedClient(texts);
  } catch {
    return [];
  }
}

// --- Data maintenance ---

export function pruneOldEvents(retentionDays = RETENTION_DAYS) {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
}

export function pruneOldEvaluations(retentionDays = EVALUATION_RETENTION_DAYS) {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  db.prepare('DELETE FROM evaluations WHERE ts < ? AND deployed_at IS NULL').run(cutoff);
  db.prepare('DELETE FROM generated_skills WHERE ts < ? AND deployed = 0').run(cutoff);
}

// --- Advisory lock for analysis ---

export function acquireAnalysisLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const content = readFileSync(LOCK_PATH, 'utf-8');
      const { pid, ts } = JSON.parse(content);
      // Stale lock? (older than 5 minutes)
      if (Date.now() - new Date(ts).getTime() > 300000) {
        unlinkSync(LOCK_PATH);
      } else {
        return false; // Lock held by another process
      }
    }
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function releaseAnalysisLock() {
  try {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  } catch { /* ignore */ }
}

// --- Stdin reader (for hooks) ---

export function readStdin(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(data ? JSON.parse(data) : {});
    }, timeoutMs);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    process.stdin.resume();
  });
}

// --- Utility helpers ---

export function getProjectName(cwd) {
  return basename(cwd || process.cwd());
}

export function getProjectPath(cwd) {
  return process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
}

export function stripPrivateTags(text) {
  if (!text) return '';
  return text.replace(/<private>[\s\S]*?<\/private>/g, '').trim();
}

export function contentHash(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
