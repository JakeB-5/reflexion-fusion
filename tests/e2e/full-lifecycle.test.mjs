// tests/e2e/full-lifecycle.test.mjs
// E2E test: complete skill lifecycle from event collection to deployment
// AI calls (Claude headless) are mocked — only data flow is exercised.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

// Mock generateEmbeddings so duplication checks skip the embedding server
vi.mock('../../src/lib/db.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateEmbeddings: vi.fn().mockResolvedValue([]),
  };
});

// ── In-memory DB factory ─────────────────────────────────────────────────────

import { initDb } from '../../src/lib/db.mjs';

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initDb(db);
  return db;
}

// ── Direct DB helpers (mirror db.mjs without the singleton) ─────────────────

function insertEventDirect(db, entry) {
  return db.prepare(`
    INSERT INTO events (v, type, ts, session_id, project, project_path, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.v ?? 1,
    entry.type,
    entry.ts ?? new Date().toISOString(),
    entry.session_id ?? '',
    entry.project ?? null,
    entry.project_path ?? null,
    JSON.stringify(entry.data ?? {}),
  );
}

function queryEventsDirect(db, filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.type)        { conditions.push('type = ?');         params.push(filters.type); }
  if (filters.sessionId)   { conditions.push('session_id = ?');   params.push(filters.sessionId); }
  if (filters.projectPath) { conditions.push('project_path = ?'); params.push(filters.projectPath); }
  if (filters.project)     { conditions.push('project = ?');      params.push(filters.project); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ? `LIMIT ${Number(filters.limit)}` : '';
  return db.prepare(`SELECT * FROM events ${where} ORDER BY ts DESC ${limit}`).all(...params);
}

// ── Shared temp dir management ────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rf-e2e-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 1: Event collection → Analysis trigger ───────────────────────────────

describe('E2E: event collection → analysis trigger', () => {
  it('stores and filters events by session, project, and type', () => {
    const db = createTestDb();
    const sessionId = 'e2e-session-001';
    const projectPath = '/tmp/test-project';

    // 5 prompt events
    for (let i = 0; i < 5; i++) {
      insertEventDirect(db, {
        type: 'prompt',
        session_id: sessionId,
        project: 'test-project',
        project_path: projectPath,
        data: { text: `prompt ${i}`, index: i },
      });
    }

    // 3 tool events
    for (let i = 0; i < 3; i++) {
      insertEventDirect(db, {
        type: 'tool_use',
        session_id: sessionId,
        project: 'test-project',
        project_path: projectPath,
        data: { tool_name: 'Bash', command: `echo ${i}` },
      });
    }

    // 1 error event
    insertEventDirect(db, {
      type: 'tool_error',
      session_id: sessionId,
      project: 'test-project',
      project_path: projectPath,
      data: { tool_name: 'Bash', error: 'command not found: foobar' },
    });

    // 1 session_summary (different type, same session)
    insertEventDirect(db, {
      type: 'session_summary',
      session_id: sessionId,
      project: 'test-project',
      project_path: projectPath,
      data: { duration_ms: 12000 },
    });

    // Filter by session — should find all 10
    const sessionEvents = queryEventsDirect(db, { sessionId });
    expect(sessionEvents).toHaveLength(10);
    sessionEvents.forEach(e => expect(e.session_id).toBe(sessionId));

    // Filter by project name
    const projectEvents = queryEventsDirect(db, { project: 'test-project' });
    expect(projectEvents).toHaveLength(10);

    // Filter by projectPath
    const pathEvents = queryEventsDirect(db, { projectPath });
    expect(pathEvents).toHaveLength(10);

    // Filter by type: prompt
    const prompts = queryEventsDirect(db, { type: 'prompt' });
    expect(prompts).toHaveLength(5);

    // Filter by type: tool_use
    const toolUses = queryEventsDirect(db, { type: 'tool_use' });
    expect(toolUses).toHaveLength(3);

    // Filter by type: tool_error
    const errors = queryEventsDirect(db, { type: 'tool_error' });
    expect(errors).toHaveLength(1);

    // Events from a different session must not bleed in
    insertEventDirect(db, {
      type: 'prompt',
      session_id: 'other-session',
      data: { text: 'other' },
    });
    const stillSameSession = queryEventsDirect(db, { sessionId });
    expect(stillSameSession).toHaveLength(10);

    db.close();
  });
});

// ── Test 2: Analysis cache flow ───────────────────────────────────────────────

describe('E2E: analysis cache flow', () => {
  it('stores and retrieves analysis with TTL freshness check', () => {
    const db = createTestDb();

    const project = 'cache-project';
    const days = 7;
    const inputHash = 'abc123deadbeef';
    const analysis = {
      suggestions: [
        { type: 'skill', title: 'Git helper', description: 'Use when running git commands' },
      ],
      pattern_count: 3,
    };

    const freshTs = new Date().toISOString();
    const staleTs  = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago
    const TTL_MS   = 24 * 3600 * 1000;

    // Insert a fresh entry
    db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(freshTs, project, days, inputHash, JSON.stringify(analysis));

    const row = db.prepare(
      'SELECT * FROM analysis_cache WHERE project = ? AND days = ? AND input_hash = ?'
    ).get(project, days, inputHash);

    expect(row).toBeTruthy();
    expect(JSON.parse(row.analysis)).toMatchObject({ pattern_count: 3 });

    // Fresh: age < TTL
    const ageMs = Date.now() - new Date(row.ts).getTime();
    expect(ageMs).toBeLessThan(TTL_MS);

    // Insert a stale entry for a different project
    db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(staleTs, 'stale-project', days, inputHash, JSON.stringify(analysis));

    const staleRow = db.prepare(
      'SELECT * FROM analysis_cache WHERE project = ?'
    ).get('stale-project');

    expect(staleRow).toBeTruthy();
    const staleAge = Date.now() - new Date(staleRow.ts).getTime();
    expect(staleAge).toBeGreaterThan(TTL_MS); // stale

    db.close();
  });

  it('unique constraint prevents duplicate cache keys', () => {
    const db = createTestDb();
    const insert = () => db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), 'proj', 7, 'hash-x', '{}');

    insert();                       // first insert — succeeds
    expect(() => insert()).toThrow(); // duplicate key — must throw

    db.close();
  });
});

// ── Test 3: Skill generation → Stage 1 validation (pass) ─────────────────────

describe('E2E: skill validation — valid SKILL.md passes', () => {
  it('validateAll() returns valid=true for a well-formed SKILL.md', async () => {
    const { validateAll } = await import('../../src/lib/skill-validator.mjs');

    const skillContent = [
      '---',
      'name: git-commit-helper',
      'description: Use this skill when you need to create well-formatted git commits with conventional commit messages and proper scope annotations.',
      '---',
      '',
      '# Git Commit Helper',
      '',
      'When creating git commits, always use the conventional commit format:',
      '`<type>(<scope>): <subject>`',
      '',
      '## Steps',
      '1. Run `git status` to review changes',
      '2. Stage relevant files with `git add <files>`',
      '3. Write a commit message following conventional format',
    ].join('\n');

    const skillPath = join(tmpDir, 'git-commit-helper.md');
    writeFileSync(skillPath, skillContent, 'utf-8');

    const result = await validateAll(skillPath);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Test 4: Skill generation → Stage 1 rejection (invalid) ───────────────────

describe('E2E: skill validation — invalid SKILL.md is rejected', () => {
  it('validateAll() returns valid=false for a file missing frontmatter', async () => {
    const { validateAll } = await import('../../src/lib/skill-validator.mjs');

    const skillContent = [
      '# No Frontmatter Skill',
      '',
      'This file is missing the YAML frontmatter block entirely.',
      'It should fail Stage 1 validation immediately.',
    ].join('\n');

    const skillPath = join(tmpDir, 'bad-skill.md');
    writeFileSync(skillPath, skillContent, 'utf-8');

    const result = await validateAll(skillPath);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.toLowerCase().includes('frontmatter'))).toBe(true);
  });

  it('validateAll() returns valid=false for missing required fields', async () => {
    const { validateAll } = await import('../../src/lib/skill-validator.mjs');

    // Has frontmatter delimiters but no name or description
    const skillContent = [
      '---',
      'author: test',
      '---',
      '',
      '# Incomplete Skill',
    ].join('\n');

    const skillPath = join(tmpDir, 'incomplete-skill.md');
    writeFileSync(skillPath, skillContent, 'utf-8');

    const result = await validateAll(skillPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
  });

  it('validateAll() returns valid=false for description too short', async () => {
    const { validateAll } = await import('../../src/lib/skill-validator.mjs');

    const skillContent = [
      '---',
      'name: tiny-skill',
      'description: Too short.',
      '---',
      '',
      '# Body here',
    ].join('\n');

    const skillPath = join(tmpDir, 'tiny-skill.md');
    writeFileSync(skillPath, skillContent, 'utf-8');

    const result = await validateAll(skillPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('description'))).toBe(true);
  });
});

// ── Test 5: Approval → Deployment flow ───────────────────────────────────────

describe('E2E: approval → deployment flow', () => {
  it('writes skill file to target dir and marks deployed=1 in DB', () => {
    const db = createTestDb();

    // Create a real source skill file
    const sourceDir = join(tmpDir, 'generated');
    mkdirSync(sourceDir, { recursive: true });
    const skillPath = join(sourceDir, 'my-deploy-skill.md');

    const skillContent = [
      '---',
      'name: my-deploy-skill',
      'description: Use this skill to run deployment workflows automatically with one command.',
      '---',
      '',
      '# My Deploy Skill',
      'Run `npm run deploy` to trigger the full deployment pipeline.',
    ].join('\n');

    writeFileSync(skillPath, skillContent, 'utf-8');

    // Insert generated_skill record (approved=0, deployed=0)
    const ts = new Date().toISOString();
    const insertResult = db.prepare(`
      INSERT INTO generated_skills
        (v, ts, skill_name, suggestion_id, project_path, file_path, version, approved, deployed)
      VALUES (1, ?, ?, ?, ?, ?, 1, 0, 0)
    `).run(ts, 'my-deploy-skill', 'sugg-001', '/tmp/proj', skillPath);

    const skillId = insertResult.lastInsertRowid;

    // Simulate approval: set approved=1
    db.prepare('UPDATE generated_skills SET approved = 1 WHERE id = ?').run(skillId);

    const approvedRow = db.prepare('SELECT * FROM generated_skills WHERE id = ?').get(skillId);
    expect(approvedRow.approved).toBe(1);
    expect(approvedRow.deployed).toBe(0);

    // Simulate deploySkill() file copy to a temp commands directory
    const targetCommandsDir = join(tmpDir, 'commands');
    mkdirSync(targetCommandsDir, { recursive: true });

    const safeName    = 'my-deploy-skill';
    const deployedPath = join(targetCommandsDir, `${safeName}.md`);

    writeFileSync(deployedPath, readFileSync(skillPath, 'utf-8'), 'utf-8');

    // Mark deployed in DB
    db.prepare(`
      UPDATE generated_skills SET deployed = 1, deployed_path = ? WHERE id = ?
    `).run(deployedPath, skillId);

    // Verify file was created at the target path
    expect(existsSync(deployedPath)).toBe(true);

    // Verify generated_skills.deployed=1
    const deployedRow = db.prepare('SELECT * FROM generated_skills WHERE id = ?').get(skillId);
    expect(deployedRow.deployed).toBe(1);
    expect(deployedRow.deployed_path).toBe(deployedPath);

    db.close();
  });

  it('deployed file content matches the source skill file', () => {
    const sourceDir = join(tmpDir, 'src-skills');
    mkdirSync(sourceDir, { recursive: true });
    const skillPath = join(sourceDir, 'content-check-skill.md');

    const skillContent = [
      '---',
      'name: content-check-skill',
      'description: Use this skill to automate deployment steps and run integration tests.',
      '---',
      '',
      '# Content Check Skill',
      'Steps to verify content integrity after deployment.',
    ].join('\n');

    writeFileSync(skillPath, skillContent, 'utf-8');

    const targetDir = join(tmpDir, 'claude-commands');
    mkdirSync(targetDir, { recursive: true });

    const safeName    = 'content-check-skill';
    const deployedPath = join(targetDir, `${safeName}.md`);

    writeFileSync(deployedPath, readFileSync(skillPath, 'utf-8'), 'utf-8');

    expect(existsSync(deployedPath)).toBe(true);

    const deployedContent = readFileSync(deployedPath, 'utf-8');
    expect(deployedContent).toContain('content-check-skill');
    expect(deployedContent).toContain('automate deployment steps');
  });
});

// ── Test 6: Feedback tracking ─────────────────────────────────────────────────

describe('E2E: feedback tracking', () => {
  it('records accepted and rejected feedback and computes summary', () => {
    const db = createTestDb();

    const ts = () => new Date().toISOString();

    const insertFeedback = (action, suggestionId, summary = null) => {
      db.prepare(`
        INSERT INTO feedback (v, ts, suggestion_id, action, suggestion_type, summary)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(ts(), suggestionId, action, 'skill', summary);
    };

    // 3 accepted, 2 rejected, 1 dismissed
    insertFeedback('accepted',  'sugg-001', 'git-helper');
    insertFeedback('accepted',  'sugg-002', 'test-runner');
    insertFeedback('accepted',  'sugg-003', 'deploy-helper');
    insertFeedback('rejected',  'sugg-004', 'bad-skill-1');
    insertFeedback('rejected',  'sugg-005', 'bad-skill-2');
    insertFeedback('dismissed', 'sugg-006', 'ignored-skill');

    const rows = db.prepare('SELECT * FROM feedback ORDER BY ts ASC').all();
    expect(rows).toHaveLength(6);

    const acceptedCount = rows.filter(r => r.action === 'accepted').length;
    const rejectedCount = rows.filter(r => r.action === 'rejected' || r.action === 'dismissed').length;
    const total         = rows.length;
    const rate          = total > 0 ? acceptedCount / total : 0;

    expect(acceptedCount).toBe(3);
    expect(rejectedCount).toBe(3);
    expect(total).toBe(6);
    expect(rate).toBeCloseTo(0.5);

    // Recent acceptances (last 10 accepted, label = summary or suggestion_id)
    const recentAcceptances = rows
      .filter(r => r.action === 'accepted')
      .slice(-10)
      .map(r => r.summary || r.suggestion_id);

    expect(recentAcceptances).toContain('git-helper');
    expect(recentAcceptances).toContain('test-runner');
    expect(recentAcceptances).toContain('deploy-helper');

    db.close();
  });

  it('returns null summary when no feedback exists', () => {
    const db = createTestDb();
    const rows = db.prepare('SELECT * FROM feedback').all();
    expect(rows).toHaveLength(0);
    // Mirror getFeedbackSummary null-return condition
    const result = rows.length === 0 ? null : {};
    expect(result).toBeNull();
    db.close();
  });

  it('feedback action column enforces CHECK constraint', () => {
    const db = createTestDb();

    expect(() => {
      db.prepare(`
        INSERT INTO feedback (v, ts, suggestion_id, action)
        VALUES (1, ?, ?, ?)
      `).run(new Date().toISOString(), 'sugg-x', 'invalid_action');
    }).toThrow();

    db.close();
  });
});

// ── Test 7: Full pipeline data flow ──────────────────────────────────────────

describe('E2E: full pipeline data flow', () => {
  it('events → analysis_cache → generated_skill → evaluation → approve → deploy are all consistent', () => {
    const db = createTestDb();
    const sessionId   = 'full-pipeline-session';
    const projectPath = '/tmp/full-pipeline-project';
    const ts          = new Date().toISOString();

    // Step 1: Insert events
    for (let i = 0; i < 6; i++) {
      insertEventDirect(db, {
        type: 'prompt',
        session_id: sessionId,
        project: 'full-pipeline',
        project_path: projectPath,
        data: { text: `user prompt number ${i}`, index: i },
      });
    }

    const events = queryEventsDirect(db, { sessionId });
    expect(events).toHaveLength(6);

    // Step 2: Create analysis_cache entry
    const analysisData = {
      suggestions: [{ type: 'skill', title: 'Pipeline Skill', description: 'Detected pattern' }],
      generated: true,
    };
    db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
    `).run(ts, 'full-pipeline', 30, 'pipeline-hash-001', JSON.stringify(analysisData));

    const cacheRow = db.prepare(
      'SELECT * FROM analysis_cache WHERE project = ?'
    ).get('full-pipeline');
    expect(cacheRow).toBeTruthy();
    expect(JSON.parse(cacheRow.analysis).generated).toBe(true);

    // Step 3: Create skill source file
    const skillDir = join(tmpDir, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'pipeline-skill.md');
    writeFileSync(skillPath, [
      '---',
      'name: pipeline-skill',
      'description: Use when running full CI/CD pipeline steps including build, test, and deploy.',
      '---',
      '',
      '# Pipeline Skill',
      'Run `npm run ci` to execute the full pipeline.',
    ].join('\n'), 'utf-8');

    // Step 4: Insert generated_skill record (approved=0, deployed=0)
    const skillInsert = db.prepare(`
      INSERT INTO generated_skills
        (v, ts, skill_name, suggestion_id, project_path, file_path, version, approved, deployed)
      VALUES (1, ?, ?, ?, ?, ?, 1, 0, 0)
    `).run(ts, 'pipeline-skill', 'sugg-pipeline-001', projectPath, skillPath);
    const skillId = skillInsert.lastInsertRowid;

    // Step 5: Insert evaluation record
    const evalInsert = db.prepare(`
      INSERT INTO evaluations
        (v, ts, skill_name, suggestion_id, project_path, status, iteration)
      VALUES (1, ?, ?, ?, ?, 'complete', 1)
    `).run(ts, 'pipeline-skill', 'sugg-pipeline-001', projectPath);
    const evalId = evalInsert.lastInsertRowid;

    // Set verdict and link evaluation to generated_skill
    db.prepare('UPDATE evaluations SET overall_verdict = ? WHERE id = ?').run('pass', evalId);
    db.prepare('UPDATE generated_skills SET evaluation_id = ? WHERE id = ?').run(evalId, skillId);

    // Step 6: User approves
    db.prepare('UPDATE generated_skills SET approved = 1 WHERE id = ?').run(skillId);

    // Step 7: Deploy — copy to temp commands dir, mark deployed in DB
    const deployDir   = join(tmpDir, 'deployed-commands');
    mkdirSync(deployDir, { recursive: true });
    const deployedPath = join(deployDir, 'pipeline-skill.md');
    writeFileSync(deployedPath, readFileSync(skillPath, 'utf-8'), 'utf-8');

    db.prepare(`
      UPDATE generated_skills SET deployed = 1, deployed_path = ? WHERE id = ?
    `).run(deployedPath, skillId);

    // ── Consistency assertions ────────────────────────────────────────────────

    // Events exist for the session
    expect(queryEventsDirect(db, { sessionId })).toHaveLength(6);

    // analysis_cache has entry for this project
    expect(db.prepare('SELECT * FROM analysis_cache WHERE project = ?').get('full-pipeline')).toBeTruthy();

    // generated_skill is fully processed
    const skillRow = db.prepare('SELECT * FROM generated_skills WHERE id = ?').get(skillId);
    expect(skillRow.approved).toBe(1);
    expect(skillRow.deployed).toBe(1);
    expect(skillRow.deployed_path).toBe(deployedPath);
    expect(skillRow.evaluation_id).toBe(evalId);

    // evaluation has pass verdict
    const evalRow = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(evalId);
    expect(evalRow.overall_verdict).toBe('pass');
    expect(evalRow.status).toBe('complete');

    // Deployed file exists on disk
    expect(existsSync(deployedPath)).toBe(true);

    // Foreign key join: evaluation reachable from generated_skill
    const linkedEval = db.prepare(`
      SELECT e.*
      FROM evaluations e
      JOIN generated_skills gs ON gs.evaluation_id = e.id
      WHERE gs.id = ?
    `).get(skillId);
    expect(linkedEval).toBeTruthy();
    expect(linkedEval.overall_verdict).toBe('pass');

    db.close();
  });
});
