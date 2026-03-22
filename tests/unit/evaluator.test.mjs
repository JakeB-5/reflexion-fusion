// tests/unit/evaluator.test.mjs
// Unit tests for src/lib/evaluator.mjs

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

let testDb;

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db) {
  db.exec(`
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
      evaluation_id INTEGER,
      approved INTEGER DEFAULT 0,
      deployed INTEGER DEFAULT 0,
      deployed_path TEXT
    );
  `);
}

// Mock Claude CLI
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock db.mjs — keep real initDb, override getDb
vi.mock('../../src/lib/db.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => testDb };
});

// Mock skill-validator to avoid slow embedding model load
vi.mock('../../src/lib/skill-validator.mjs', () => ({
  validateAll: vi.fn(),
}));

import { execSync } from 'child_process';
import { validateAll } from '../../src/lib/skill-validator.mjs';
import { evaluateSkill, checkDailyLimit, evaluateOnDemand } from '../../src/lib/evaluator.mjs';

// ── checkDailyLimit ─────────────────────────────────────────────────────────

describe('checkDailyLimit', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
  });

  afterEach(() => { testDb.close(); });

  it('returns true when no evaluations exist', () => {
    expect(checkDailyLimit(null)).toBe(true);
  });

  it('returns false when at the daily limit (5 evaluations today)', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      testDb.prepare(
        'INSERT INTO evaluations (ts, skill_name, status) VALUES (?, ?, ?)',
      ).run(now, `skill-${i}`, 'complete');
    }
    expect(checkDailyLimit(null)).toBe(false);
  });

  it('ignores evaluations from previous days', () => {
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString();
    for (let i = 0; i < 10; i++) {
      testDb.prepare(
        'INSERT INTO evaluations (ts, skill_name, status) VALUES (?, ?, ?)',
      ).run(yesterday, `old-${i}`, 'complete');
    }
    expect(checkDailyLimit(null)).toBe(true);
  });
});

// ── evaluateSkill ───────────────────────────────────────────────────────────

describe('evaluateSkill', () => {
  let tmpDir;

  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    tmpDir = mkdtempSync(join(tmpdir(), 'eval-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns fail when Stage 1 validation fails', async () => {
    const skillPath = join(tmpDir, 'bad-skill.md');
    writeFileSync(skillPath, 'no frontmatter');

    validateAll.mockResolvedValue({
      valid: false,
      errors: ['Missing YAML frontmatter'],
      warnings: [],
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('fail');
    expect(result.evaluation.stage).toBe('validation');
    expect(result.evaluation.errors).toContain('Missing YAML frontmatter');

    // DB should record the failure
    const row = testDb.prepare('SELECT * FROM evaluations WHERE skill_name = ?').get('bad-skill');
    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
  });

  it('returns fail when validateAll throws an exception', async () => {
    const skillPath = join(tmpDir, 'crash-skill.md');
    writeFileSync(skillPath, 'content');

    validateAll.mockRejectedValue(new Error('validator crashed'));

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('fail');
    expect(result.evaluation.error).toBe('validator crashed');
  });

  it('returns fail when file cannot be read after validation', async () => {
    // Provide a non-existent path (validateAll is mocked so it doesn't read the file)
    const missingPath = join(tmpDir, 'ghost.md');
    validateAll.mockResolvedValue({ valid: true, errors: [], warnings: [] });

    const result = await evaluateSkill(missingPath);

    expect(result.verdict).toBe('fail');
    expect(result.evaluation.stage).toBe('grading');
  });

  it('proceeds to Stage 2 and returns pass on successful grading', async () => {
    const skillPath = join(tmpDir, 'good-skill.md');
    writeFileSync(skillPath, '---\nname: good-skill\ndescription: A well-designed skill\n---\n# Good\nContent');

    validateAll.mockResolvedValue({ valid: true, errors: [], warnings: [] });

    // Mock Claude responses in call sequence
    let callIdx = 0;
    execSync.mockImplementation(() => {
      callIdx++;
      switch (callIdx) {
        case 1: return '```json\n{"prompts": ["test the skill"]}\n```';
        case 2: return 'baseline: generic response text';
        case 3: return 'skill: enhanced detailed response text';
        case 4: return '```json\n{"baseline_score": 5, "skill_score": 8, "reasoning": "improved", "verdict": "pass"}\n```';
        case 5: return '```json\n{"verdict": "pass", "summary": "skill is good", "suggestions": []}\n```';
        default: return '{}';
      }
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('pass');
    expect(result.evaluation.iteration).toBe(1);

    const row = testDb.prepare('SELECT * FROM evaluations WHERE skill_name = ?').get('good-skill');
    expect(row.status).toBe('complete');
    expect(row.overall_verdict).toBe('pass');
  });

  it('records fail verdict with analyzer output', async () => {
    const skillPath = join(tmpDir, 'bad-quality.md');
    writeFileSync(skillPath, '---\nname: bad-quality\ndescription: test\n---\n# Bad');

    validateAll.mockResolvedValue({ valid: true, errors: [], warnings: [] });

    let callIdx = 0;
    execSync.mockImplementation(() => {
      callIdx++;
      switch (callIdx) {
        case 1: return '```json\n{"prompts": ["try this"]}\n```';
        case 2: return 'baseline response';
        case 3: return 'barely different response';
        case 4: return '```json\n{"baseline_score": 7, "skill_score": 3, "reasoning": "worse", "verdict": "fail"}\n```';
        case 5: return '```json\n{"verdict": "fail", "summary": "skill hurts quality", "suggestions": ["rewrite"]}\n```';
        case 6: return '```json\n{"suggestions": ["be more specific"], "revised_description": "better"}\n```';
        default: return '{}';
      }
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('fail');
    expect(result.evaluation.analysis).not.toBeNull();

    const row = testDb.prepare('SELECT * FROM evaluations WHERE skill_name = ?').get('bad-quality');
    expect(row.overall_verdict).toBe('fail');
    expect(row.analysis).not.toBeNull();
  });
});

// ── evaluateOnDemand ────────────────────────────────────────────────────────

describe('evaluateOnDemand', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => { testDb.close(); });

  it('returns fail when skill is not found in DB', async () => {
    const result = await evaluateOnDemand('non-existent');
    expect(result.verdict).toBe('fail');
    expect(result.evaluation.error).toContain('not found');
  });

  it('returns fail when skill file is missing on disk', async () => {
    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path) VALUES (?, ?, ?)',
    ).run(new Date().toISOString(), 'ghost', '/no/such/file.md');

    const result = await evaluateOnDemand('ghost');
    expect(result.verdict).toBe('fail');
    expect(result.evaluation.error).toContain('missing on disk');
  });
});

// ── improve loop — skill regeneration ───────────────────────────────────────

describe('evaluateSkill — improve loop with regeneration', () => {
  let tmpDir;

  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    tmpDir = mkdtempSync(join(tmpdir(), 'improve-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('regenerates skill on improve verdict and passes on second iteration', async () => {
    const skillPath = join(tmpDir, 'improving-skill.md');
    writeFileSync(skillPath, '---\nname: improving-skill\ndescription: needs work\n---\n# V1');

    validateAll.mockResolvedValue({ valid: true, errors: [], warnings: [] });

    // Mock Claude calls for 2 iterations:
    // Iter 1: grade→improve, compare→improve, analyze→suggestions, regenerate
    // Iter 2: grade→pass, compare→pass
    let callIdx = 0;
    execSync.mockImplementation(() => {
      callIdx++;
      switch (callIdx) {
        // Iteration 1
        case 1: return '```json\n{"prompts": ["test it"]}\n```';
        case 2: return 'baseline response';
        case 3: return 'skill v1 response';
        case 4: return '```json\n{"baseline_score": 6, "skill_score": 6, "reasoning": "equal", "verdict": "improve"}\n```';
        case 5: return '```json\n{"verdict": "improve", "summary": "needs more detail", "suggestions": ["add examples"]}\n```';
        case 6: return '```json\n{"suggestions": ["add concrete examples"], "revised_description": "better desc"}\n```';
        // regenerateSkill call
        case 7: return '---\nname: improving-skill\ndescription: better desc\n---\n# V2 Improved';
        // Iteration 2
        case 8: return '```json\n{"prompts": ["test improved"]}\n```';
        case 9: return 'baseline response 2';
        case 10: return 'skill v2 much better response';
        case 11: return '```json\n{"baseline_score": 5, "skill_score": 9, "reasoning": "much better", "verdict": "pass"}\n```';
        case 12: return '```json\n{"verdict": "pass", "summary": "great improvement", "suggestions": []}\n```';
        default: return '{}';
      }
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('pass');
    expect(result.evaluation.iteration).toBe(2);

    // Verify file was updated with improved content
    const fileContent = readFileSync(skillPath, 'utf-8');
    expect(fileContent).toContain('V2 Improved');

    // DB should show complete with pass
    const row = testDb.prepare('SELECT * FROM evaluations WHERE skill_name = ?').get('improving-skill');
    expect(row.status).toBe('complete');
    expect(row.overall_verdict).toBe('pass');
    expect(row.iteration).toBe(2);
  });
});
