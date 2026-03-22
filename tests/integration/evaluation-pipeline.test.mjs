// tests/integration/evaluation-pipeline.test.mjs
// Integration test: skill validation → evaluation → approval → deployment pipeline

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

let testDb;
// vi.hoisted ensures value is available before vi.mock factory runs
const TEST_HOME = vi.hoisted(() => `/tmp/eval-pipe-${process.pid}`);

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

// Mock child_process for Claude CLI
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock db.mjs — keep real initDb, override getDb
vi.mock('../../src/lib/db.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDb: () => testDb,
    GLOBAL_DIR: `${TEST_HOME}/.reflexion-fusion`,
  };
});

// Mock skill-validator
vi.mock('../../src/lib/skill-validator.mjs', () => ({
  validateAll: vi.fn(),
}));

import { initDb } from '../../src/lib/db.mjs';
import { execSync } from 'child_process';
import { validateAll } from '../../src/lib/skill-validator.mjs';
import { evaluateSkill, checkDailyLimit } from '../../src/lib/evaluator.mjs';

// Dynamic import for auto-deployer (needs HOME set first)
let deploySkill, listPendingApprovals;
let origHome;

beforeAll(async () => {
  origHome = process.env.HOME;
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.HOME = TEST_HOME;

  const mod = await import('../../src/lib/auto-deployer.mjs');
  deploySkill = mod.deploySkill;
  listPendingApprovals = mod.listPendingApprovals;
});

afterAll(() => {
  process.env.HOME = origHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── end-to-end evaluation pipeline ──────────────────────────────────────────

describe('evaluation pipeline — end-to-end', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipe-'));
    rmSync(join(TEST_HOME, '.claude'), { recursive: true, force: true });
    testDb = createTestDb();
    initDb(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Stage 1 fail → status=failed, no Claude calls made', async () => {
    const skillPath = join(tmpDir, 'invalid-skill.md');
    writeFileSync(skillPath, 'invalid content without frontmatter');

    validateAll.mockResolvedValue({
      valid: false,
      errors: ['Missing frontmatter', 'Missing name field'],
      warnings: [],
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('fail');
    expect(execSync).not.toHaveBeenCalled();

    const evals = testDb.prepare('SELECT * FROM evaluations').all();
    expect(evals).toHaveLength(1);
    expect(evals[0].status).toBe('failed');
    expect(evals[0].error_message).toContain('Missing frontmatter');
  });

  it('Stage 1 pass → Stage 2 pass → evaluation complete', async () => {
    const skillPath = join(tmpDir, 'quality-skill.md');
    writeFileSync(skillPath, [
      '---',
      'name: quality-skill',
      'description: A well-designed skill for testing evaluation pipeline',
      '---',
      '# Quality Skill',
      'Detailed instructions here.',
    ].join('\n'));

    validateAll.mockResolvedValue({ valid: true, errors: [], warnings: [] });

    let callIdx = 0;
    execSync.mockImplementation(() => {
      callIdx++;
      switch (callIdx) {
        case 1: return '```json\n{"prompts": ["test the skill"]}\n```';
        case 2: return 'baseline: generic response';
        case 3: return 'skill: enhanced detailed response with better quality';
        case 4: return '```json\n{"baseline_score": 4, "skill_score": 9, "reasoning": "much better", "verdict": "pass"}\n```';
        case 5: return '```json\n{"verdict": "pass", "summary": "excellent", "suggestions": []}\n```';
        default: return '{}';
      }
    });

    const result = await evaluateSkill(skillPath);

    expect(result.verdict).toBe('pass');

    // Verify DB state
    const evals = testDb.prepare('SELECT * FROM evaluations').all();
    expect(evals).toHaveLength(1);
    expect(evals[0].status).toBe('complete');
    expect(evals[0].overall_verdict).toBe('pass');
    expect(evals[0].grading).not.toBeNull();
    expect(evals[0].comparison).not.toBeNull();
  });

  it('daily limit prevents evaluation when exceeded', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      testDb.prepare(
        'INSERT INTO evaluations (ts, skill_name, status) VALUES (?, ?, ?)',
      ).run(now, `eval-${i}`, 'complete');
    }

    expect(checkDailyLimit(null)).toBe(false);
  });

  it('approval and deployment flow works end-to-end', () => {
    // Create source skill file
    const srcDir = join(tmpDir, 'generated');
    mkdirSync(srcDir, { recursive: true });
    const srcPath = join(srcDir, 'approved-skill.md');
    writeFileSync(srcPath, '# Approved Skill\nContent here');

    // Insert pending generated_skill
    testDb.prepare(`
      INSERT INTO generated_skills (ts, skill_name, file_path, approved, deployed)
      VALUES (?, ?, ?, 0, 0)
    `).run(new Date().toISOString(), 'approved-skill', srcPath);

    // Verify pending list
    const pending = listPendingApprovals(null);
    expect(pending).toHaveLength(1);
    expect(pending[0].skill_name).toBe('approved-skill');

    // Deploy the skill
    const result = deploySkill({
      skill_name: 'approved-skill',
      file_path: srcPath,
    });

    expect(existsSync(result.deployedPath)).toBe(true);

    // Verify DB records deployment
    const row = testDb.prepare(
      'SELECT deployed, deployed_path FROM generated_skills WHERE skill_name = ?',
    ).get('approved-skill');
    expect(row.deployed).toBe(1);
    expect(row.deployed_path).toBeTruthy();
  });
});
