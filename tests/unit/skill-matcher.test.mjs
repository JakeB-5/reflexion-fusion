// tests/unit/skill-matcher.test.mjs
// Unit tests for src/lib/skill-matcher.mjs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPatterns, matchSkill, loadSkills } from '../../src/lib/skill-matcher.mjs';

// ── extractPatterns ─────────────────────────────────────────────────────────

describe('extractPatterns', () => {
  it('extracts bullet items from 감지된 패턴 section', () => {
    const content = [
      '# My Skill',
      '',
      '## 감지된 패턴',
      '- deploy production server',
      '- run integration tests',
      '',
      '## Usage',
      '- not a pattern',
    ].join('\n');

    expect(extractPatterns(content)).toEqual([
      'deploy production server',
      'run integration tests',
    ]);
  });

  it('returns empty array when section is absent', () => {
    expect(extractPatterns('# Just a heading\nSome body text')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractPatterns('')).toEqual([]);
  });

  it('stops collecting at the next heading', () => {
    const content = '## 감지된 패턴\n- pattern A\n# Next\n- not this';
    expect(extractPatterns(content)).toEqual(['pattern A']);
  });

  it('strips surrounding quotes from patterns', () => {
    const content = '## 감지된 패턴\n- "quoted pattern"';
    expect(extractPatterns(content)).toEqual(['quoted pattern']);
  });

  it('ignores non-list lines inside the section', () => {
    const content = '## 감지된 패턴\nplain text\n- real pattern\nmore text';
    expect(extractPatterns(content)).toEqual(['real pattern']);
  });
});

// ── matchSkill — keyword fallback path ──────────────────────────────────────

describe('matchSkill — keyword fallback', () => {
  const skills = [
    {
      name: 'deploy-helper',
      scope: 'global',
      content: '# Deploy\n## 감지된 패턴\n- deploy production server\n- vercel deployment setup',
      description: 'Deployment helper',
      sourcePath: '/fake/deploy-helper.md',
    },
    {
      name: 'test-runner',
      scope: 'project',
      content: '# Tests\n## 감지된 패턴\n- run unit tests\n- vitest execution coverage',
      description: 'Test runner',
      sourcePath: '/fake/test-runner.md',
    },
  ];

  it('matches when ≥50% of pattern words (≥3 chars) appear in prompt', async () => {
    // "deploy production server" → 3 words ≥3 chars: deploy, production, server
    // prompt has "deploy" + "server" → 2/3 = 67%
    const result = await matchSkill('deploy the server now', skills);
    expect(result).not.toBeNull();
    expect(result.name).toBe('deploy-helper');
    expect(result.match).toBe('keyword');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns null when no pattern matches', async () => {
    const result = await matchSkill('refactor database schema migration', skills);
    expect(result).toBeNull();
  });

  it('is case-insensitive', async () => {
    const result = await matchSkill('DEPLOY THE SERVER PRODUCTION', skills);
    expect(result).not.toBeNull();
    expect(result.name).toBe('deploy-helper');
  });

  it('includes scope from matched skill', async () => {
    const result = await matchSkill('run unit tests now', skills);
    expect(result).not.toBeNull();
    expect(result.scope).toBe('project');
  });

  it('returns first matching skill when multiple could match', async () => {
    const result = await matchSkill('deploy production server', skills);
    expect(result.name).toBe('deploy-helper');
  });

  it('handles skills with no patterns section gracefully', async () => {
    const noPatternSkills = [
      { name: 'empty', scope: 'global', content: '# No patterns', description: null, sourcePath: '/x' },
    ];
    const result = await matchSkill('anything here', noPatternSkills);
    expect(result).toBeNull();
  });
});

// ── loadSkills ──────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-matcher-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads .md files from project .claude/commands/', () => {
    const dir = join(tmpDir, '.claude', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'my-skill.md'), '# My Skill\nA helpful description');

    const skills = loadSkills(tmpDir);
    const proj = skills.filter(s => s.scope === 'project');

    expect(proj.some(s => s.name === 'my-skill')).toBe(true);
    const skill = proj.find(s => s.name === 'my-skill');
    expect(skill.description).toBe('A helpful description');
  });

  it('ignores non-.md files', () => {
    const dir = join(tmpDir, '.claude', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'not a skill');
    writeFileSync(join(dir, 'real.md'), '# Real\nDescription');

    const skills = loadSkills(tmpDir).filter(s => s.scope === 'project');

    expect(skills.every(s => s.name !== 'notes')).toBe(true);
    expect(skills.some(s => s.name === 'real')).toBe(true);
  });

  it('returns no project skills for non-existent dir', () => {
    const proj = loadSkills(join(tmpDir, 'no-such-dir')).filter(s => s.scope === 'project');
    expect(proj).toHaveLength(0);
  });

  it('extracts description from first non-heading line', () => {
    const dir = join(tmpDir, '.claude', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'desc.md'), '# H1\n## H2\nActual description line');

    const skill = loadSkills(tmpDir).find(s => s.name === 'desc');
    expect(skill?.description).toBe('Actual description line');
  });
});
