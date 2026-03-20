// Integration test: Hook pipeline — event collection flow
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

describe('Hook Pipeline Integration', () => {
  let db;

  beforeEach(() => {
    const Database = require('better-sqlite3');
    db = new Database(':memory:');

    // Manually import and run initDb
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    db.exec(`
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

      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        v INTEGER DEFAULT 1,
        ts TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('accepted','rejected','dismissed')),
        suggestion_type TEXT,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS analysis_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        project TEXT,
        days INTEGER,
        input_hash TEXT,
        analysis JSON NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        v INTEGER DEFAULT 1,
        ts TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        suggestion_id TEXT,
        project_path TEXT,
        status TEXT DEFAULT 'pending',
        validation JSON,
        grading JSON,
        comparison JSON,
        analysis JSON,
        overall_verdict TEXT,
        iteration INTEGER DEFAULT 1,
        deployed_at TEXT,
        error_message TEXT
      );

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
  });

  afterEach(() => {
    if (db) db.close();
  });

  describe('Event collection flow', () => {
    it('should insert prompt events and query by session', () => {
      const sessionId = 'test-session-001';
      const ts = new Date().toISOString();

      db.prepare(`
        INSERT INTO events (v, type, ts, session_id, project, project_path, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'prompt', ts, sessionId, 'test-project', '/tmp/test', JSON.stringify({
        text: 'Write a function that sorts an array',
        charCount: 38,
      }));

      const rows = db.prepare('SELECT * FROM events WHERE session_id = ?').all(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('prompt');

      const data = JSON.parse(rows[0].data);
      expect(data.text).toContain('sorts an array');
    });

    it('should insert tool_use and tool_error events in sequence', () => {
      const sessionId = 'test-session-002';
      const ts1 = new Date(Date.now() - 1000).toISOString();
      const ts2 = new Date().toISOString();

      // Tool use
      db.prepare(`
        INSERT INTO events (v, type, ts, session_id, project, project_path, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'tool_use', ts1, sessionId, 'test', '/tmp/test', JSON.stringify({
        tool: 'Bash',
        meta: { command: 'npm' },
        success: true,
      }));

      // Tool error
      db.prepare(`
        INSERT INTO events (v, type, ts, session_id, project, project_path, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'tool_error', ts2, sessionId, 'test', '/tmp/test', JSON.stringify({
        tool: 'Bash',
        error: 'Command not found: npx',
      }));

      const rows = db.prepare(
        'SELECT * FROM events WHERE session_id = ? ORDER BY ts'
      ).all(sessionId);
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe('tool_use');
      expect(rows[1].type).toBe('tool_error');
    });

    it('should store session summaries with aggregate data', () => {
      const sessionId = 'test-session-003';

      // Insert prompts
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO events (v, type, ts, session_id, project, project_path, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, 'prompt', new Date(Date.now() - (5 - i) * 1000).toISOString(),
          sessionId, 'test', '/tmp/test', JSON.stringify({ text: `prompt ${i}` }));
      }

      // Insert session summary
      const summary = {
        promptCount: 5,
        toolCounts: { Bash: 3, Edit: 2 },
        errorCount: 1,
        uniqueErrors: ['Command not found'],
        lastEditedFiles: ['src/index.mjs'],
      };
      db.prepare(`
        INSERT INTO events (v, type, ts, session_id, project, project_path, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'session_summary', new Date().toISOString(),
        sessionId, 'test', '/tmp/test', JSON.stringify(summary));

      const summaryRow = db.prepare(
        "SELECT * FROM events WHERE type = 'session_summary' AND session_id = ?"
      ).get(sessionId);
      expect(summaryRow).toBeDefined();

      const data = JSON.parse(summaryRow.data);
      expect(data.promptCount).toBe(5);
      expect(data.toolCounts.Bash).toBe(3);
    });
  });

  describe('Error KB flow', () => {
    it('should store and retrieve error resolutions', () => {
      const ts = new Date().toISOString();

      db.prepare(`
        INSERT INTO error_kb (ts, error_normalized, error_raw, resolution, resolved_by, use_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ts, 'Module not found: <STR>', 'Module not found: "lodash"',
        JSON.stringify({ resolvedBy: 'Bash', tool: 'npm install' }), 'Bash', 1);

      const row = db.prepare('SELECT * FROM error_kb WHERE error_normalized = ?')
        .get('Module not found: <STR>');
      expect(row).toBeDefined();
      expect(row.use_count).toBe(1);

      const resolution = JSON.parse(row.resolution);
      expect(resolution.resolvedBy).toBe('Bash');
    });
  });

  describe('Analysis cache flow', () => {
    it('should cache and retrieve analysis results', () => {
      const ts = new Date().toISOString();
      const analysis = {
        suggestions: [
          { type: 'skill', id: 'suggest-0', summary: 'Test skill', priority: 1 },
        ],
      };

      db.prepare(`
        INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
        VALUES (?, ?, ?, ?, ?)
      `).run(ts, 'test-project', 7, 'abc123hash', JSON.stringify(analysis));

      const cached = db.prepare(
        'SELECT * FROM analysis_cache WHERE project = ? AND input_hash = ?'
      ).get('test-project', 'abc123hash');
      expect(cached).toBeDefined();

      const parsed = JSON.parse(cached.analysis);
      expect(parsed.suggestions).toHaveLength(1);
      expect(parsed.suggestions[0].type).toBe('skill');
    });
  });

  describe('Evaluation + generated_skills flow', () => {
    it('should track evaluation lifecycle', () => {
      const ts = new Date().toISOString();

      // Create evaluation
      const evalResult = db.prepare(`
        INSERT INTO evaluations (v, ts, skill_name, status, project_path)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, ts, 'test-skill', 'pending', '/tmp/test');
      const evalId = evalResult.lastInsertRowid;

      // Create generated skill
      db.prepare(`
        INSERT INTO generated_skills (v, ts, skill_name, file_path, evaluation_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, ts, 'test-skill', '/tmp/test-skill.md', evalId);

      // Update evaluation status
      db.prepare('UPDATE evaluations SET status = ?, overall_verdict = ? WHERE id = ?')
        .run('complete', 'pass', evalId);

      // Verify
      const eval_ = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(evalId);
      expect(eval_.status).toBe('complete');
      expect(eval_.overall_verdict).toBe('pass');

      const skill = db.prepare('SELECT * FROM generated_skills WHERE evaluation_id = ?').get(evalId);
      expect(skill.skill_name).toBe('test-skill');
      expect(skill.approved).toBe(0); // Not yet approved
    });

    it('should track approval and deployment', () => {
      const ts = new Date().toISOString();

      db.prepare(`
        INSERT INTO generated_skills (v, ts, skill_name, file_path, approved, deployed, deployed_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, ts, 'deployed-skill', '/tmp/skill.md', 1, 1, '~/.claude/commands/deployed-skill.md');

      const deployed = db.prepare(
        'SELECT * FROM generated_skills WHERE deployed = 1'
      ).all();
      expect(deployed).toHaveLength(1);
      expect(deployed[0].approved).toBe(1);
      expect(deployed[0].deployed_path).toContain('deployed-skill.md');
    });
  });
});
