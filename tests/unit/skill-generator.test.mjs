// tests/unit/skill-generator.test.mjs
// Unit tests for src/lib/skill-generator.mjs

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

// --- Test DB infrastructure ---
let testDb;
// vi.hoisted ensures value is available before vi.mock factory runs
const TEST_GENERATED_DIR = vi.hoisted(() => `/tmp/rf-gen-test-${process.pid}`);

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
  `);
}

// --- Mocks ---
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../src/lib/db.mjs', () => ({
  getDb: () => testDb,
  GENERATED_DIR: TEST_GENERATED_DIR,
  initDb: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  generateSkill,
  generateClaudeMdRule,
  generateHookWorkflow,
  findExistingSkill,
  regenerateSkill,
} from '../../src/lib/skill-generator.mjs';

// ── generateSkill ───────────────────────────────────────────────────────────

describe('generateSkill', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    mkdirSync(TEST_GENERATED_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(TEST_GENERATED_DIR, { recursive: true, force: true });
  });

  it('writes the generated SKILL.md and returns metadata', async () => {
    execSync.mockReturnValue([
      '```skill',
      '---',
      'name: test-deploy',
      'description: Deploy helper skill',
      '---',
      '',
      '# Test Deploy',
      'Run vercel deploy',
      '```',
    ].join('\n'));

    const result = await generateSkill(
      { id: 'sug-1', skillName: 'test-deploy', summary: 'deploy helper' },
      ['deploy my app'],
      ['Bash'],
    );

    expect(result.skillName).toBe('test-deploy');
    expect(result.filePath).toContain('test-deploy.md');
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.content).toContain('Test Deploy');
  });

  it('derives name from frontmatter when skillName is absent', async () => {
    execSync.mockReturnValue('---\nname: auto-derived\ndescription: test\n---\ncontent');

    const result = await generateSkill({ id: 'sug-2', summary: 'test' });
    expect(result.skillName).toBe('auto-derived');
  });

  it('sanitizes skill name for filename', async () => {
    execSync.mockReturnValue('---\nname: My Skill!@#\n---\ncontent');

    const result = await generateSkill({ id: 'sug-3', summary: 'test' });
    // Non-alphanumeric chars become hyphens, lowercased
    expect(result.filePath).toMatch(/my-skill/);
    expect(result.filePath).toMatch(/\.md$/);
  });

  it('records the skill in generated_skills table', async () => {
    execSync.mockReturnValue('```skill\n---\nname: recorded\n---\nbody\n```');

    await generateSkill({ id: 'sug-4', skillName: 'recorded' });

    const row = testDb.prepare('SELECT * FROM generated_skills WHERE skill_name = ?').get('recorded');
    expect(row).toBeDefined();
    expect(row.deployed).toBe(0);
    expect(row.file_path).toContain('recorded.md');
  });

  it('handles Claude output without fenced block', async () => {
    execSync.mockReturnValue('---\nname: raw-output\n---\n# Raw\nDirect output');

    const result = await generateSkill({ id: 'sug-5', summary: 'test' });
    expect(result.content).toContain('---');
    expect(result.content).toContain('Raw');
  });
});

// ── generateClaudeMdRule ────────────────────────────────────────────────────

describe('generateClaudeMdRule', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('parses JSON response from Claude', async () => {
    execSync.mockReturnValue('```json\n{"rule": "Always use TypeScript", "scope": "global"}\n```');

    const result = await generateClaudeMdRule({ summary: 'use ts' });
    expect(result.rule).toBe('Always use TypeScript');
    expect(result.scope).toBe('global');
  });

  it('returns project scope when Claude responds with project', async () => {
    execSync.mockReturnValue('```json\n{"rule": "Use vitest", "scope": "project"}\n```');

    const result = await generateClaudeMdRule({ summary: 'test framework' });
    expect(result.scope).toBe('project');
  });

  it('falls back to suggestion data on parse failure', async () => {
    execSync.mockReturnValue('totally not json at all');

    const result = await generateClaudeMdRule({
      rule: 'fallback rule text',
      summary: 'fallback summary',
    });
    expect(result.rule).toBe('fallback rule text');
    expect(result.scope).toBe('global');
  });
});

// ── generateHookWorkflow ────────────────────────────────────────────────────

describe('generateHookWorkflow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('parses JSON response from Claude', async () => {
    execSync.mockReturnValue(
      '```json\n{"code": "console.log(1)", "hookEvent": "PostToolUse", "description": "log tool"}\n```',
    );

    const result = await generateHookWorkflow({ summary: 'logging' });
    expect(result.code).toBe('console.log(1)');
    expect(result.hookEvent).toBe('PostToolUse');
    expect(result.description).toBe('log tool');
  });

  it('falls back to suggestion data on parse failure', async () => {
    execSync.mockReturnValue('invalid output');

    const result = await generateHookWorkflow({
      hookCode: 'fallback code',
      hookEvent: 'SessionEnd',
      summary: 'fallback desc',
    });
    expect(result.code).toBe('fallback code');
    expect(result.hookEvent).toBe('SessionEnd');
    expect(result.description).toBe('fallback desc');
  });
});

// ── findExistingSkill ───────────────────────────────────────────────────────

describe('findExistingSkill', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    mkdirSync(TEST_GENERATED_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(TEST_GENERATED_DIR, { recursive: true, force: true });
  });

  it('returns existing skill when name matches', () => {
    const filePath = join(TEST_GENERATED_DIR, 'existing.md');
    writeFileSync(filePath, '# Existing Skill\nContent');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path) VALUES (?, ?, ?)',
    ).run(new Date().toISOString(), 'existing', filePath);

    const result = findExistingSkill({ skillName: 'existing' });

    expect(result).not.toBeNull();
    expect(result.skillName).toBe('existing');
    expect(result.content).toContain('Existing Skill');
  });

  it('returns null when no matching name', () => {
    const result = findExistingSkill({ skillName: 'no-match' });
    expect(result).toBeNull();
  });

  it('returns null when skillName is absent', () => {
    const result = findExistingSkill({ summary: 'something' });
    expect(result).toBeNull();
  });

  it('returns null when file is missing on disk', () => {
    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path) VALUES (?, ?, ?)',
    ).run(new Date().toISOString(), 'ghost', '/no/such/file.md');

    const result = findExistingSkill({ skillName: 'ghost' });
    expect(result).toBeNull();
  });
});

// ── regenerateSkill ─────────────────────────────────────────────────────────

describe('regenerateSkill', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls Claude with existing content + suggestions and returns improved content', () => {
    execSync.mockReturnValue('---\nname: improved\ndescription: better\n---\n# Improved');

    const result = regenerateSkill(
      '---\nname: original\n---\n# Original',
      ['Be more specific', 'Add examples'],
    );

    expect(result).toContain('improved');
    expect(execSync).toHaveBeenCalledTimes(1);
    // Verify prompt includes suggestions
    const promptArg = execSync.mock.calls[0][1]?.input || '';
    expect(promptArg).toContain('Be more specific');
    expect(promptArg).toContain('Add examples');
  });

  it('includes revisedDescription in prompt when provided', () => {
    execSync.mockReturnValue('---\nname: v2\n---\ncontent');

    regenerateSkill('original', ['fix it'], 'A much better description');

    const promptArg = execSync.mock.calls[0][1]?.input || '';
    expect(promptArg).toContain('A much better description');
  });
});

// ── generateSkill — duplicate detection path ────────────────────────────────

describe('generateSkill — duplicate detection', () => {
  beforeEach(() => {
    testDb = createTestDb();
    initSchema(testDb);
    mkdirSync(TEST_GENERATED_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
    rmSync(TEST_GENERATED_DIR, { recursive: true, force: true });
  });

  it('improves existing skill instead of creating new when name matches', async () => {
    const filePath = join(TEST_GENERATED_DIR, 'deploy-helper.md');
    writeFileSync(filePath, '---\nname: deploy-helper\n---\n# Old Version');

    testDb.prepare(
      'INSERT INTO generated_skills (ts, skill_name, file_path, version) VALUES (?, ?, ?, 1)',
    ).run(new Date().toISOString(), 'deploy-helper', filePath);

    // Mock Claude to return improved content
    execSync.mockReturnValue('---\nname: deploy-helper\n---\n# Improved Version');

    const result = await generateSkill({ skillName: 'deploy-helper', summary: 'better deploy' });

    expect(result.skillName).toBe('deploy-helper');
    expect(result.content).toContain('Improved Version');
    expect(result.filePath).toBe(filePath);

    // Version should be bumped in DB
    const row = testDb.prepare('SELECT version FROM generated_skills WHERE skill_name = ?').get('deploy-helper');
    expect(row.version).toBe(2);
  });
});
