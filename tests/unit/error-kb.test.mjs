// tests/unit/error-kb.test.mjs
// Unit tests for src/lib/error-kb.mjs

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Isolated DB helper ────────────────────────────────────────────────────────

import { initDb } from '../../src/lib/db.mjs';
import { normalizeError, recordResolution, searchErrorKB } from '../../src/lib/error-kb.mjs';

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initDb(db);
  return db;
}

// Override the module-level getDb so error-kb uses our isolated test DB.
// We do this by mocking db.mjs before importing error-kb.mjs.
// Because vitest ESM mocking requires hoisting, we use a module-level approach:
// patch getDb on the already-loaded db module via a shared reference.

// ── normalizeError (pure function — no DB needed) ────────────────────────────

describe('normalizeError', () => {
  it('replaces double-quoted strings with <STR>', () => {
    const result = normalizeError('Error: "some file.txt" not found');
    expect(result).toContain('<STR>');
    expect(result).not.toContain('"some file.txt"');
  });

  it('replaces single-quoted strings with <STR>', () => {
    const result = normalizeError("Cannot read 'myVar'");
    expect(result).toContain('<STR>');
    expect(result).not.toContain("'myVar'");
  });

  it('replaces absolute file paths with <PATH>', () => {
    const result = normalizeError('File /home/user/project/src/index.js not found');
    expect(result).toContain('<PATH>');
    expect(result).not.toContain('/home/user/project/src/index.js');
  });

  it('replaces relative paths starting with ./ with <PATH>', () => {
    const result = normalizeError('Cannot open ./relative/path/file.ts');
    expect(result).toContain('<PATH>');
    expect(result).not.toContain('./relative/path/file.ts');
  });

  it('replaces multi-digit numbers with <N>', () => {
    const result = normalizeError('Error at line 42, column 100');
    expect(result).toContain('<N>');
    expect(result).not.toContain('42');
    expect(result).not.toContain('100');
  });

  it('does not replace single-digit numbers', () => {
    const result = normalizeError('retry 3 times');
    // Single digit — should NOT be replaced
    expect(result).toContain('3');
  });

  it('truncates output to 200 characters', () => {
    const long = 'x'.repeat(500);
    const result = normalizeError(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeError('')).toBe('');
    expect(normalizeError(null)).toBe('');
    expect(normalizeError(undefined)).toBe('');
  });

  it('applies all replacements in correct order (quoted paths become <STR> not <PATH>)', () => {
    // Quoted path should be replaced by <STR> before the path rule runs
    const result = normalizeError('Error reading "/etc/hosts"');
    // The quoted string rule fires first
    expect(result).toContain('<STR>');
  });
});

// ── DB-backed tests (searchErrorKB, recordResolution) ────────────────────────
// We need getDb() inside error-kb.mjs to return our test DB.
// Strategy: use vi.mock to intercept the db module used by error-kb.mjs.

describe('recordResolution + searchErrorKB', () => {
  let testDb;

  // Before each test, create a fresh in-memory DB and patch the singleton
  // returned by getDb() in the already-loaded db module.
  beforeEach(async () => {
    testDb = createTestDb();

    // Patch the exported getDb to return our test DB.
    // error-kb.mjs imports { getDb, vectorSearch, generateEmbeddings } from '../lib/db.mjs'
    // We import the same db module and replace _db by overwriting the singleton via
    // the module's closeDb/getDb lifecycle — simplest approach is to directly
    // insert into the real singleton via the module itself.
    // Since db.mjs exports getDb which returns _db (singleton), we need a seam.
    // Cleanest solution: import closeDb and use the actual DB_PATH pointing to
    // a temp file. But even simpler: use vi.mock at module scope (hoisted).
    // Here we take the approach of inserting directly into the DB returned by getDb().

    // Actually the cleanest testable approach for already-loaded modules:
    // call initDb on the singleton db directly.
    const dbMod = await import('../../src/lib/db.mjs');
    const realDb = dbMod.getDb();

    // Wipe all tables so each test starts clean
    realDb.exec(`
      DELETE FROM error_kb;
      DELETE FROM events;
      DELETE FROM feedback;
      DELETE FROM analysis_cache;
    `);
  });

  afterEach(() => {
    if (testDb && testDb.open) testDb.close();
  });

  describe('recordResolution', () => {
    it('inserts a new entry into error_kb', async () => {
      const dbMod = await import('../../src/lib/db.mjs');
      const db = dbMod.getDb();

      recordResolution('TypeError: cannot read properties of <STR>', {
        errorRaw: 'TypeError: cannot read properties of "undefined"',
        resolvedBy: 'add null check',
        toolSequence: ['Read', 'Edit'],
      });

      const row = db.prepare('SELECT * FROM error_kb WHERE error_normalized = ?')
        .get('TypeError: cannot read properties of <STR>');

      expect(row).toBeTruthy();
      expect(row.error_normalized).toBe('TypeError: cannot read properties of <STR>');
      expect(row.resolved_by).toBe('add null check');
      expect(row.tool_sequence).toBe('["Read","Edit"]');
      expect(row.use_count).toBe(1);
    });

    it('increments use_count on duplicate normalized error', async () => {
      const dbMod = await import('../../src/lib/db.mjs');
      const db = dbMod.getDb();

      const norm = 'SyntaxError: unexpected token <STR>';

      recordResolution(norm, { resolvedBy: 'fix syntax' });
      recordResolution(norm, { resolvedBy: 'fix syntax again' });

      const row = db.prepare('SELECT * FROM error_kb WHERE error_normalized = ?').get(norm);
      expect(row.use_count).toBe(2);
    });

    it('accepts snake_case field aliases', async () => {
      const dbMod = await import('../../src/lib/db.mjs');
      const db = dbMod.getDb();

      recordResolution('Module not found: <STR>', {
        error_raw: 'Module not found: "lodash"',
        resolved_by: 'npm install',
        tool_sequence: ['Bash'],
      });

      const row = db.prepare('SELECT * FROM error_kb WHERE error_normalized = ?')
        .get('Module not found: <STR>');

      expect(row).toBeTruthy();
      expect(row.resolved_by).toBe('npm install');
    });

    it('does nothing when called with falsy arguments', () => {
      // Should not throw
      expect(() => recordResolution(null, {})).not.toThrow();
      expect(() => recordResolution('', null)).not.toThrow();
    });
  });

  describe('searchErrorKB', () => {
    it('returns a match on exact normalized error', async () => {
      const dbMod = await import('../../src/lib/db.mjs');
      const db = dbMod.getDb();

      const norm = 'ReferenceError: <STR> is not defined';

      // Insert directly so resolution is set
      db.prepare(`
        INSERT INTO error_kb (ts, error_normalized, error_raw, resolution, resolved_by, use_count)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(
        new Date().toISOString(),
        norm,
        'ReferenceError: "myVar" is not defined',
        JSON.stringify({ resolvedBy: 'declare variable' }),
        'declare variable',
      );

      const result = await searchErrorKB(norm);
      expect(result).not.toBeNull();
      expect(result.error_normalized).toBe(norm);
    });

    it('returns null when no matching entry exists', async () => {
      const result = await searchErrorKB('completely unknown error pattern xyz');
      expect(result).toBeNull();
    });

    it('returns null for falsy input', async () => {
      expect(await searchErrorKB('')).toBeNull();
      expect(await searchErrorKB(null)).toBeNull();
    });

    it('increments use_count on exact match hit', async () => {
      const dbMod = await import('../../src/lib/db.mjs');
      const db = dbMod.getDb();

      const norm = 'ENOENT: no such file or directory <PATH>';

      db.prepare(`
        INSERT INTO error_kb (ts, error_normalized, error_raw, resolution, resolved_by, use_count)
        VALUES (?, ?, ?, ?, ?, 2)
      `).run(
        new Date().toISOString(),
        norm,
        'ENOENT raw',
        JSON.stringify({ resolvedBy: 'create file' }),
        'create file',
      );

      await searchErrorKB(norm);

      const row = db.prepare('SELECT use_count FROM error_kb WHERE error_normalized = ?').get(norm);
      expect(row.use_count).toBe(3);
    });
  });
});
