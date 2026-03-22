// tests/unit/auto-deployer.test.mjs
// Unit tests for src/lib/auto-deployer.mjs

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

let testDb;
const TEST_HOME = mkdtempSync(join(tmpdir(), `deployer-test-${process.pid}-`));
const TEST_GLOBAL_DIR = join(TEST_HOME, '.reflexion-fusion');

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
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      v INTEGER DEFAULT 1,
      ts TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      suggestion_id TEXT,
      project_path TEXT,
      status TEXT DEFAULT 'pending',
      overall_verdict TEXT,
      iteration INTEGER DEFAULT 1,
      error_message TEXT
    );
  `);
}

// Mock db.mjs
vi.mock('../../src/lib/db.mjs', () => ({
  getDb: () => testDb,
  GLOBAL_DIR: TEST_GLOBAL_DIR,
  initDb: vi.fn(),
}));

// Set HOME and dynamically import auto-deployer so module-level constants use TEST_HOME
let deploySkill, deployClaudeMdRule, deployHookWorkflow, rollback, listPendingApprovals;
let origHome;

beforeAll(async () => {
  origHome = process.env.HOME;
  process.env.HOME = TEST_HOME;

  const mod = await import('../../src/lib/auto-deployer.mjs');
  deploySkill = mod.deploySkill;
  deployClaudeMdRule = mod.deployClaudeMdRule;
  deployHookWorkflow = mod.deployHookWorkflow;
  rollback = mod.rollback;
  listPendingApprovals = mod.listPendingApprovals;
});

afterAll(() => {
  process.env.HOME = origHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── deploySkill ─────────────────────────────────────────────────────────────

describe('deploySkill', () => {
  beforeEach(() => {
    // Clean HOME directory structure between tests
    rmSync(join(TEST_HOME, '.claude'), { recursive: true, force: true });
    testDb = createTestDb();
    initSchema(testDb);
  });

  afterEach(() => { testDb.close(); });

  it('deploys skill to global commands directory', () => {
    const srcDir = join(TEST_HOME, 'source');
    mkdirSync(srcDir, { recursive: true });
    const srcPath = join(srcDir, 'my-skill.md');
    writeFileSync(srcPath, '# My Skill\nContent');

    const result = deploySkill({ skill_name: 'my-skill', file_path: srcPath });

    expect(result.deployedPath).toContain('.claude/commands/my-skill.md');
    expect(existsSync(result.deployedPath)).toBe(true);
    expect(readFileSync(result.deployedPath, 'utf-8')).toBe('# My Skill\nContent');
  });

  it('deploys to project directory when scope is project', () => {
    const projDir = join(TEST_HOME, 'myproject');
    mkdirSync(projDir, { recursive: true });
    const srcPath = join(TEST_HOME, 'src.md');
    writeFileSync(srcPath, 'project skill content');

    const result = deploySkill(
      { skill_name: 'proj-skill', file_path: srcPath, project_path: projDir },
      'project',
    );

    expect(result.deployedPath).toContain(join(projDir, '.claude', 'commands'));
    expect(existsSync(result.deployedPath)).toBe(true);
  });

  it('creates backup when target file already exists', () => {
    const targetDir = join(TEST_HOME, '.claude', 'commands');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'conflict.md'), 'old content');

    const srcPath = join(TEST_HOME, 'new.md');
    writeFileSync(srcPath, 'new content');

    const result = deploySkill({ skill_name: 'conflict', file_path: srcPath });

    expect(result.conflict).toBe(true);
    expect(result.backedUp).toBe(true);
    expect(existsSync(`${result.deployedPath}.bak`)).toBe(true);
    expect(readFileSync(`${result.deployedPath}.bak`, 'utf-8')).toBe('old content');
  });

  it('throws when source file does not exist', () => {
    expect(() => {
      deploySkill({ skill_name: 'ghost', file_path: '/no/such/file.md' });
    }).toThrow('Source skill file not found');
  });
});

// ── deployClaudeMdRule ──────────────────────────────────────────────────────

describe('deployClaudeMdRule', () => {
  beforeEach(() => {
    rmSync(join(TEST_HOME, '.claude'), { recursive: true, force: true });
    testDb = createTestDb();
    initSchema(testDb);
  });

  afterEach(() => { testDb.close(); });

  it('creates CLAUDE.md with rule section when file does not exist', () => {
    const result = deployClaudeMdRule({ rule: 'Always use TypeScript' });

    expect(result.created).toBe(true);
    const content = readFileSync(result.claudeMdPath, 'utf-8');
    expect(content).toContain('## 자동 감지된 규칙');
    expect(content).toContain('- Always use TypeScript');
  });

  it('appends rule under existing section', () => {
    const claudeDir = join(TEST_HOME, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      '# Config\n\n## 자동 감지된 규칙\n- existing rule\n',
    );

    deployClaudeMdRule({ rule: 'New rule here' });

    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- New rule here');
    expect(content).toContain('- existing rule');
  });

  it('creates section at end when file exists but section is absent', () => {
    const claudeDir = join(TEST_HOME, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# Existing Content\nSome text');

    deployClaudeMdRule({ rule: 'Appended rule' });

    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# Existing Content');
    expect(content).toContain('## 자동 감지된 규칙');
    expect(content).toContain('- Appended rule');
  });

  it('throws when rule text is empty', () => {
    expect(() => { deployClaudeMdRule({ rule: '' }); }).toThrow('Rule text is empty');
    expect(() => { deployClaudeMdRule({ rule: '  ' }); }).toThrow('Rule text is empty');
  });
});

// ── rollback ────────────────────────────────────────────────────────────────

describe('rollback', () => {
  beforeEach(() => {
    rmSync(join(TEST_HOME, '.claude'), { recursive: true, force: true });
    testDb = createTestDb();
    initSchema(testDb);
  });

  afterEach(() => { testDb.close(); });

  it('restores backup file and resets DB state', () => {
    const deployPath = join(TEST_HOME, 'deployed.md');
    writeFileSync(deployPath, 'new content');
    writeFileSync(`${deployPath}.bak`, 'original content');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, deployed, deployed_path) VALUES (?, ?, ?, 1, ?)',
    ).run(new Date().toISOString(), 'test-skill', '/src.md', deployPath);

    const id = testDb.prepare('SELECT id FROM generated_skills LIMIT 1').get().id;
    const result = rollback(id);

    expect(result.restored).toBe(true);
    expect(readFileSync(deployPath, 'utf-8')).toBe('original content');

    const row = testDb.prepare('SELECT deployed, deployed_path FROM generated_skills WHERE id = ?').get(id);
    expect(row.deployed).toBe(0);
    expect(row.deployed_path).toBeNull();
  });

  it('returns restored=false when no backup exists', () => {
    const deployPath = join(TEST_HOME, 'no-backup.md');
    writeFileSync(deployPath, 'content');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, deployed, deployed_path) VALUES (?, ?, ?, 1, ?)',
    ).run(new Date().toISOString(), 'no-backup', '/src.md', deployPath);

    const id = testDb.prepare('SELECT id FROM generated_skills LIMIT 1').get().id;
    const result = rollback(id);

    expect(result.restored).toBe(false);
  });

  it('returns restored=false for non-existent deployment id', () => {
    const result = rollback(9999);
    expect(result.restored).toBe(false);
    expect(result.path).toBeNull();
  });
});

// ── listPendingApprovals ────────────────────────────────────────────────────

describe('listPendingApprovals', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
  });

  afterEach(() => { testDb.close(); });

  it('returns only unapproved, undeployed skills', () => {
    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, approved, deployed, project_path) VALUES (?, ?, ?, 0, 0, ?)',
    ).run(new Date().toISOString(), 'pending-skill', '/some/path.md', '/proj');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, approved, deployed, project_path) VALUES (?, ?, ?, 1, 1, ?)',
    ).run(new Date().toISOString(), 'deployed-skill', '/other.md', '/proj');

    const pending = listPendingApprovals('/proj');
    expect(pending).toHaveLength(1);
    expect(pending[0].skill_name).toBe('pending-skill');
  });

  it('returns all pending when projectPath is null', () => {
    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, approved, deployed, project_path) VALUES (?, ?, ?, 0, 0, ?)',
    ).run(new Date().toISOString(), 'skill-a', '/a.md', '/proj-a');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, approved, deployed, project_path) VALUES (?, ?, ?, 0, 0, ?)',
    ).run(new Date().toISOString(), 'skill-b', '/b.md', '/proj-b');

    const pending = listPendingApprovals(null);
    expect(pending).toHaveLength(2);
  });
});
