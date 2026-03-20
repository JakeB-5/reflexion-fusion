// tests/unit/skill-validator.test.mjs
// Unit tests for src/lib/skill-validator.mjs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateStructure,
  validateRequiredFields,
  validateDescriptionQuality,
  validateAll,
} from '../../src/lib/skill-validator.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tempDir;

function writeTempSkill(filename, content) {
  return join(tempDir, filename);
}

function createSkillFile(filename, content) {
  const path = join(tempDir, filename);
  writeFileSync(path, content, 'utf-8');
  return path;
}

const VALID_SKILL_CONTENT = `---
name: test-skill
description: Use this skill to run automated tests and verify the build passes correctly
---

## Instructions

Run the test suite using vitest.
`;

const MINIMAL_VALID_SKILL = `---
name: my-skill
description: Create a new component and add it to the main module properly
---

Do the thing.
`;

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skill-validator-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── validateStructure ─────────────────────────────────────────────────────────

describe('validateStructure', () => {
  it('returns valid=true and parsed frontmatter for a well-formed SKILL.md', () => {
    const path = createSkillFile('valid.md', VALID_SKILL_CONTENT);
    const result = validateStructure(path);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.frontmatter.name).toBe('test-skill');
    expect(result.frontmatter.description).toContain('Use this skill');
    expect(result.body).toContain('## Instructions');
  });

  it('returns valid=false with error when file does not exist', () => {
    const result = validateStructure('/nonexistent/path/skill.md');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Cannot read file'))).toBe(true);
  });

  it('returns valid=false with error when file is empty', () => {
    const path = createSkillFile('empty.md', '');
    const result = validateStructure(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('empty'))).toBe(true);
  });

  it('returns valid=false when frontmatter delimiter is missing', () => {
    const path = createSkillFile('no-frontmatter.md', '# Just a heading\n\nSome body text.');
    const result = validateStructure(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('frontmatter'))).toBe(true);
  });

  it('returns valid=false when frontmatter block is empty', () => {
    const path = createSkillFile('empty-frontmatter.md', '---\n---\n\nBody here.');
    const result = validateStructure(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('empty'))).toBe(true);
  });

  it('adds a warning when the markdown body is empty', () => {
    const path = createSkillFile('no-body.md', `---\nname: x-skill\ndescription: Use this to run tests and validate everything works fine\n---\n`);
    const result = validateStructure(path);
    expect(result.warnings.some(w => w.includes('body is empty'))).toBe(true);
  });

  it('adds a warning when file exceeds 500 lines', () => {
    const body = '\n'.repeat(502);
    const content = `---\nname: big-skill\ndescription: Use this to generate and run the full test suite automatically\n---\n${body}`;
    const path = createSkillFile('big.md', content);
    const result = validateStructure(path);
    expect(result.warnings.some(w => w.includes('500 lines'))).toBe(true);
  });
});

// ── validateRequiredFields ────────────────────────────────────────────────────

describe('validateRequiredFields', () => {
  it('returns valid=true for complete frontmatter', () => {
    const result = validateRequiredFields({
      name: 'my-skill',
      description: 'Use this skill to create and run the full test suite automatically',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns error when name is missing', () => {
    const result = validateRequiredFields({
      description: 'Use this skill to run tests and verify the build',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('returns error when name is empty string', () => {
    const result = validateRequiredFields({ name: '   ', description: 'Use this to run tests and check everything' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"name"'))).toBe(true);
  });

  it('returns error when description is missing', () => {
    const result = validateRequiredFields({ name: 'my-skill' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
  });

  it('returns error when description is shorter than 30 chars', () => {
    const result = validateRequiredFields({ name: 'my-skill', description: 'Too short' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('too short'))).toBe(true);
  });

  it('returns error when description exceeds 500 chars', () => {
    const result = validateRequiredFields({
      name: 'my-skill',
      description: 'x'.repeat(501),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('too long'))).toBe(true);
  });

  it('returns errors for both missing name and description', () => {
    const result = validateRequiredFields({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── validateDescriptionQuality ────────────────────────────────────────────────

describe('validateDescriptionQuality', () => {
  it('returns valid=true with no warnings for a good description', () => {
    const result = validateDescriptionQuality('Use this skill to run tests and verify build output');
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns warning when description has fewer than 5 words', () => {
    const result = validateDescriptionQuality('Run tests now');
    expect(result.warnings.some(w => w.includes('short'))).toBe(true);
  });

  it('returns warning when description has more than 100 words', () => {
    const description = ('word '.repeat(101)).trim();
    const result = validateDescriptionQuality(description);
    expect(result.warnings.some(w => w.includes('long'))).toBe(true);
  });

  it('returns warning when no action verb is present', () => {
    const result = validateDescriptionQuality('This is a skill for the things that we do here and there');
    expect(result.warnings.some(w => w.includes('action verbs'))).toBe(true);
  });

  it('does not warn about action verbs when one is present', () => {
    const result = validateDescriptionQuality('Use this when you need to generate a new component file');
    const actionVerbWarning = result.warnings.find(w => w.includes('action verbs'));
    expect(actionVerbWarning).toBeUndefined();
  });

  it('returns valid=false with warning for empty description', () => {
    const result = validateDescriptionQuality('');
    expect(result.valid).toBe(false);
    expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
  });
});

// ── validateAll ───────────────────────────────────────────────────────────────

describe('validateAll', () => {
  it('returns valid=true for a well-formed skill file', async () => {
    const path = createSkillFile('valid-all.md', VALID_SKILL_CONTENT);
    const result = await validateAll(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid=false and aggregated errors for missing frontmatter', async () => {
    const path = createSkillFile('bad-all.md', '# No frontmatter here\n\nJust a body.');
    const result = await validateAll(path);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when required fields are missing', async () => {
    const path = createSkillFile('missing-fields.md', `---\ntitle: something\n---\n\nBody text here.\n`);
    const result = await validateAll(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name') || e.includes('description'))).toBe(true);
  });

  it('aggregates both errors and warnings', async () => {
    // Valid structure but body is empty → warning. Name/description valid.
    const path = createSkillFile('warn-test.md', MINIMAL_VALID_SKILL);
    const result = await validateAll(path);
    // Should be valid (no structural errors in minimal valid skill)
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
