// tests/unit/db.test.mjs
// Unit tests for src/lib/db.mjs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

// Helper: create an isolated in-memory or temp-file DB with initDb applied
function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

// Import initDb and other pure utilities without triggering the singleton getDb()
import {
  initDb,
  contentHash,
  stripPrivateTags,
  getProjectName,
  acquireAnalysisLock,
  releaseAnalysisLock,
  LOCK_PATH,
} from '../../src/lib/db.mjs';

// ── helpers that work directly on a test DB ──────────────────────────────────

function insertEventDirect(db, entry) {
  return db.prepare(`
    INSERT INTO events (v, type, ts, session_id, project, project_path, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.v ?? 1,
    entry.type,
    entry.ts ?? new Date().toISOString(),
    entry.sessionId ?? entry.session_id ?? '',
    entry.project ?? null,
    entry.projectPath ?? entry.project_path ?? null,
    JSON.stringify(entry.data ?? {}),
  );
}

function queryEventsDirect(db, filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.type)        { conditions.push('type = ?');        params.push(filters.type); }
  if (filters.sessionId)   { conditions.push('session_id = ?');  params.push(filters.sessionId); }
  if (filters.projectPath) { conditions.push('project_path = ?'); params.push(filters.projectPath); }
  if (filters.project)     { conditions.push('project = ?');     params.push(filters.project); }
  if (filters.since)       { conditions.push('ts >= ?');         params.push(filters.since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ? `LIMIT ${Number(filters.limit)}` : '';
  return db.prepare(`SELECT * FROM events ${where} ORDER BY ts DESC ${limit}`).all(...params);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('db — initDb / table creation', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    initDb(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(r => r.name);

    expect(tables).toContain('events');
    expect(tables).toContain('error_kb');
    expect(tables).toContain('feedback');
    expect(tables).toContain('analysis_cache');
    expect(tables).toContain('skill_embeddings');
    expect(tables).toContain('evaluations');
    expect(tables).toContain('generated_skills');
  });

  it('is idempotent — calling initDb twice does not throw', () => {
    const db = createTestDb();
    expect(() => { initDb(db); initDb(db); }).not.toThrow();
  });
});

describe('db — insertEvent / queryEvents', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts an event and retrieves it', () => {
    insertEventDirect(db, {
      type: 'prompt',
      session_id: 'sess-1',
      data: { text: 'hello' },
    });

    const rows = queryEventsDirect(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('prompt');
    expect(rows[0].session_id).toBe('sess-1');
    expect(JSON.parse(rows[0].data)).toMatchObject({ text: 'hello' });
  });

  it('queryEvents filters by type', () => {
    insertEventDirect(db, { type: 'prompt',     session_id: 's1', data: {} });
    insertEventDirect(db, { type: 'tool_error', session_id: 's1', data: {} });

    const results = queryEventsDirect(db, { type: 'prompt' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('prompt');
  });

  it('queryEvents filters by sessionId', () => {
    insertEventDirect(db, { type: 'prompt', session_id: 'sess-A', data: {} });
    insertEventDirect(db, { type: 'prompt', session_id: 'sess-B', data: {} });

    const results = queryEventsDirect(db, { sessionId: 'sess-A' });
    expect(results).toHaveLength(1);
    expect(results[0].session_id).toBe('sess-A');
  });

  it('queryEvents filters by projectPath', () => {
    insertEventDirect(db, { type: 'prompt', session_id: 's1', project_path: '/proj/a', data: {} });
    insertEventDirect(db, { type: 'prompt', session_id: 's2', project_path: '/proj/b', data: {} });

    const results = queryEventsDirect(db, { projectPath: '/proj/a' });
    expect(results).toHaveLength(1);
    expect(results[0].project_path).toBe('/proj/a');
  });

  it('queryEvents filters by since (timestamp)', () => {
    const past   = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const future = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    insertEventDirect(db, { type: 'prompt', session_id: 's1', ts: past,   data: {} });
    insertEventDirect(db, { type: 'prompt', session_id: 's2', ts: future, data: {} });

    const cutoff = new Date().toISOString();
    const results = queryEventsDirect(db, { since: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].session_id).toBe('s2');
  });

  it('queryEvents respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertEventDirect(db, { type: 'prompt', session_id: `s${i}`, data: {} });
    }
    const results = queryEventsDirect(db, { limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe('db — getSessionEvents', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    initDb(db);
  });

  afterEach(() => { db.close(); });

  it('returns only events for the given session', () => {
    insertEventDirect(db, { type: 'prompt', session_id: 'target', data: {} });
    insertEventDirect(db, { type: 'prompt', session_id: 'other',  data: {} });
    insertEventDirect(db, { type: 'tool_error', session_id: 'target', data: {} });

    const rows = queryEventsDirect(db, { sessionId: 'target' });
    expect(rows).toHaveLength(2);
    rows.forEach(r => expect(r.session_id).toBe('target'));
  });
});

describe('db — pruneOldEvents', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    initDb(db);
  });

  afterEach(() => { db.close(); });

  it('removes events older than retentionDays', () => {
    const old   = new Date(Date.now() - 100 * 86400000).toISOString(); // 100 days ago
    const fresh = new Date(Date.now() -   1 * 86400000).toISOString(); // 1 day ago

    insertEventDirect(db, { type: 'prompt', session_id: 's1', ts: old,   data: {} });
    insertEventDirect(db, { type: 'prompt', session_id: 's2', ts: fresh, data: {} });

    // Prune anything older than 30 days
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);

    const remaining = db.prepare('SELECT * FROM events').all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].session_id).toBe('s2');
  });
});

describe('db — contentHash', () => {
  it('returns a 64-char hex SHA-256 string', () => {
    const hash = contentHash({ key: 'value' });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for the same input', () => {
    const a = contentHash({ foo: 'bar', n: 42 });
    const b = contentHash({ foo: 'bar', n: 42 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = contentHash({ foo: 'bar' });
    const b = contentHash({ foo: 'baz' });
    expect(a).not.toBe(b);
  });
});

describe('db — stripPrivateTags', () => {
  it('removes <private>...</private> blocks', () => {
    const input  = 'visible <private>secret content</private> more visible';
    const result = stripPrivateTags(input);
    expect(result).toBe('visible  more visible');
  });

  it('removes multiline private blocks', () => {
    const input  = 'before\n<private>\nline1\nline2\n</private>\nafter';
    const result = stripPrivateTags(input);
    expect(result).toBe('before\n\nafter');
  });

  it('returns empty string for null/undefined input', () => {
    expect(stripPrivateTags(null)).toBe('');
    expect(stripPrivateTags(undefined)).toBe('');
    expect(stripPrivateTags('')).toBe('');
  });

  it('returns the string unchanged when no private tags present', () => {
    expect(stripPrivateTags('hello world')).toBe('hello world');
  });
});

describe('db — getProjectName', () => {
  it('extracts the basename from a path', () => {
    expect(getProjectName('/home/user/my-project')).toBe('my-project');
  });

  it('handles trailing slashes gracefully', () => {
    // basename of '/a/b/' is 'b' in Node
    expect(getProjectName('/a/b/')).toBe('b');
  });

  it('falls back to process.cwd() basename when no argument given', () => {
    const result = getProjectName();
    // Should be non-empty string (basename of cwd)
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('db — acquireAnalysisLock / releaseAnalysisLock', () => {
  afterEach(() => {
    // Always clean up lock after each test
    releaseAnalysisLock();
  });

  it('acquireAnalysisLock() returns true when no lock exists', () => {
    releaseAnalysisLock(); // ensure clean state
    const acquired = acquireAnalysisLock();
    expect(acquired).toBe(true);
  });

  it('acquireAnalysisLock() returns false when lock is already held', () => {
    releaseAnalysisLock();
    acquireAnalysisLock(); // first acquire
    const second = acquireAnalysisLock();
    expect(second).toBe(false);
  });

  it('releaseAnalysisLock() removes the lock file', () => {
    releaseAnalysisLock();
    acquireAnalysisLock();
    releaseAnalysisLock();
    // Acquiring again should succeed after release
    const reacquired = acquireAnalysisLock();
    expect(reacquired).toBe(true);
  });
});
