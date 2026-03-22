// tests/integration/analysis-pipeline.test.mjs
// Integration test: events → analysis cache → generated_skills flow

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

import { initDb, contentHash } from '../../src/lib/db.mjs';

// ── events to analysis cache ────────────────────────────────────────────────

describe('analysis pipeline — events to analysis cache', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    initDb(db);
  });

  afterEach(() => { db.close(); });

  function insertEvent(overrides = {}) {
    return db.prepare(`
      INSERT INTO events (v, type, ts, session_id, project, project_path, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      overrides.type || 'prompt',
      overrides.ts || new Date().toISOString(),
      overrides.session_id || 'test-session',
      overrides.project || 'test-project',
      overrides.project_path || '/test/path',
      JSON.stringify(overrides.data || { text: 'test prompt' }),
    );
  }

  it('events are queryable by type after insertion', () => {
    insertEvent({ type: 'prompt', data: { text: 'deploy my app' } });
    insertEvent({ type: 'tool_use', data: { tool: 'Bash', command: 'npm run build' } });
    insertEvent({ type: 'tool_error', data: { tool: 'Bash', error: 'build failed' } });

    const all = db.prepare('SELECT * FROM events').all();
    expect(all).toHaveLength(3);

    const prompts = db.prepare("SELECT * FROM events WHERE type = 'prompt'").all();
    expect(prompts).toHaveLength(1);

    const errors = db.prepare("SELECT * FROM events WHERE type = 'tool_error'").all();
    expect(errors).toHaveLength(1);
  });

  it('analysis cache deduplicates by project + days + input_hash', () => {
    const hash = contentHash({ type: 'prompt', count: 5 });

    db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), 'proj', 7, hash, JSON.stringify({ patterns: [] }));

    // Same key → REPLACE updates the existing row
    db.prepare(`
      INSERT OR REPLACE INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), 'proj', 7, hash, JSON.stringify({ patterns: ['new'] }));

    const rows = db.prepare('SELECT * FROM analysis_cache WHERE input_hash = ?').all(hash);
    expect(rows).toHaveLength(1);

    const analysis = JSON.parse(rows[0].analysis);
    expect(analysis.patterns).toContain('new');
  });

  it('events can be filtered by project_path and date range', () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86400000).toISOString();

    insertEvent({ project_path: '/proj/a', ts: recent, data: { text: 'recent A' } });
    insertEvent({ project_path: '/proj/b', ts: recent, data: { text: 'recent B' } });
    insertEvent({ project_path: '/proj/a', ts: old, data: { text: 'old A' } });

    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const rows = db.prepare(
      'SELECT * FROM events WHERE project_path = ? AND ts >= ? ORDER BY ts DESC',
    ).all('/proj/a', cutoff);

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].data).text).toBe('recent A');
  });

  it('session events can be aggregated for pattern detection', () => {
    const sessionId = 'sess-123';

    // Simulate a session with repeated tool patterns
    insertEvent({ type: 'prompt', session_id: sessionId, data: { text: 'fix the build' } });
    insertEvent({ type: 'tool_use', session_id: sessionId, data: { tool: 'Bash', command: 'npm test' } });
    insertEvent({ type: 'tool_error', session_id: sessionId, data: { tool: 'Bash', error: 'test failed' } });
    insertEvent({ type: 'tool_use', session_id: sessionId, data: { tool: 'Edit', file: 'src/app.ts' } });
    insertEvent({ type: 'tool_use', session_id: sessionId, data: { tool: 'Bash', command: 'npm test' } });

    const sessionEvents = db.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC',
    ).all(sessionId);

    expect(sessionEvents).toHaveLength(5);

    // Tool frequency
    const toolCounts = db.prepare(`
      SELECT json_extract(data, '$.tool') as tool, COUNT(*) as cnt
      FROM events
      WHERE session_id = ? AND type = 'tool_use'
      GROUP BY json_extract(data, '$.tool')
    `).all(sessionId);

    const bashCount = toolCounts.find(r => r.tool === 'Bash');
    expect(bashCount.cnt).toBe(2);
  });
});

// ── generated_skills + evaluations linkage ──────────────────────────────────

describe('analysis pipeline — generated_skills + evaluations linkage', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    initDb(db);
  });

  afterEach(() => { db.close(); });

  it('generated_skills can reference evaluations via FK', () => {
    const evalResult = db.prepare(`
      INSERT INTO evaluations (ts, skill_name, status, overall_verdict)
      VALUES (?, ?, 'complete', 'pass')
    `).run(new Date().toISOString(), 'linked-skill');

    db.prepare(`
      INSERT INTO generated_skills (ts, skill_name, file_path, evaluation_id, approved, deployed)
      VALUES (?, ?, ?, ?, 0, 0)
    `).run(new Date().toISOString(), 'linked-skill', '/path/skill.md', evalResult.lastInsertRowid);

    const rows = db.prepare(`
      SELECT gs.skill_name, gs.approved, e.overall_verdict, e.status
      FROM generated_skills gs
      LEFT JOIN evaluations e ON gs.evaluation_id = e.id
      WHERE gs.skill_name = ?
    `).all('linked-skill');

    expect(rows).toHaveLength(1);
    expect(rows[0].overall_verdict).toBe('pass');
    expect(rows[0].status).toBe('complete');
  });

  it('feedback records track user decisions on suggestions', () => {
    db.prepare(`
      INSERT INTO feedback (ts, suggestion_id, action, suggestion_type, summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), 'sug-1', 'accepted', 'skill', 'deploy helper');

    db.prepare(`
      INSERT INTO feedback (ts, suggestion_id, action, suggestion_type, summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), 'sug-2', 'dismissed', 'skill', 'bad skill');

    const accepted = db.prepare("SELECT * FROM feedback WHERE action = 'accepted'").all();
    const dismissed = db.prepare("SELECT * FROM feedback WHERE action = 'dismissed'").all();

    expect(accepted).toHaveLength(1);
    expect(dismissed).toHaveLength(1);
    expect(accepted[0].suggestion_id).toBe('sug-1');
  });

  it('pruning removes old non-deployed skills and evaluations', () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString();
    const recent = new Date().toISOString();

    db.prepare(
      'INSERT INTO evaluations (ts, skill_name, status) VALUES (?, ?, ?)',
    ).run(old, 'old-eval', 'complete');
    db.prepare(
      'INSERT INTO evaluations (ts, skill_name, status) VALUES (?, ?, ?)',
    ).run(recent, 'new-eval', 'complete');

    db.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, deployed) VALUES (?, ?, ?, 0)',
    ).run(old, 'old-skill', '/old.md');
    db.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, deployed) VALUES (?, ?, ?, 0)',
    ).run(recent, 'new-skill', '/new.md');

    // Prune evaluations older than 180 days
    const evalCutoff = new Date(Date.now() - 180 * 86400000).toISOString();
    db.prepare('DELETE FROM evaluations WHERE ts < ? AND deployed_at IS NULL').run(evalCutoff);
    db.prepare('DELETE FROM generated_skills WHERE ts < ? AND deployed = 0').run(evalCutoff);

    expect(db.prepare('SELECT * FROM evaluations').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM generated_skills').all()).toHaveLength(1);
  });
});
