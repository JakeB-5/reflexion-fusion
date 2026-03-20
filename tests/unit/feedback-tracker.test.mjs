// tests/unit/feedback-tracker.test.mjs
// Unit tests for src/lib/feedback-tracker.mjs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initDb } from '../../src/lib/db.mjs';
import { recordFeedback, getFeedbackSummary } from '../../src/lib/feedback-tracker.mjs';

// ── DB reset helper ───────────────────────────────────────────────────────────
// feedback-tracker uses getDb() which returns the global singleton.
// We reset the relevant tables before each test to ensure isolation.

async function resetTables() {
  const dbMod = await import('../../src/lib/db.mjs');
  const db = dbMod.getDb();
  db.exec(`
    DELETE FROM feedback;
    DELETE FROM events;
  `);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('recordFeedback', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('inserts a feedback record with action=accepted', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-001', 'accepted', {
      suggestionType: 'skill',
      summary: 'Auto-test skill',
    });

    const row = db.prepare("SELECT * FROM feedback WHERE suggestion_id = 'suggestion-001'").get();
    expect(row).toBeTruthy();
    expect(row.action).toBe('accepted');
    expect(row.suggestion_type).toBe('skill');
    expect(row.summary).toBe('Auto-test skill');
    expect(row.v).toBe(1);
  });

  it('inserts a feedback record with action=rejected', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-002', 'rejected', { suggestionType: 'directive' });

    const row = db.prepare("SELECT * FROM feedback WHERE suggestion_id = 'suggestion-002'").get();
    expect(row).toBeTruthy();
    expect(row.action).toBe('rejected');
  });

  it('inserts a feedback record with action=dismissed', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-003', 'dismissed', {});

    const row = db.prepare("SELECT * FROM feedback WHERE suggestion_id = 'suggestion-003'").get();
    expect(row).toBeTruthy();
    expect(row.action).toBe('dismissed');
  });

  it('also inserts a companion event in the events table (accepted → suggestion_applied)', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-004', 'accepted', {
      sessionId: 'sess-test',
      project: 'my-project',
    });

    const event = db.prepare("SELECT * FROM events WHERE type = 'suggestion_applied'").get();
    expect(event).toBeTruthy();
    expect(event.type).toBe('suggestion_applied');
    expect(event.session_id).toBe('sess-test');
    expect(event.project).toBe('my-project');
  });

  it('inserts a suggestion_rejected event for rejected action', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-005', 'rejected', { sessionId: 'sess-x' });

    const event = db.prepare("SELECT * FROM events WHERE type = 'suggestion_rejected'").get();
    expect(event).toBeTruthy();
    expect(event.type).toBe('suggestion_rejected');
  });

  it('inserts a suggestion_rejected event for dismissed action', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-006', 'dismissed', {});

    const event = db.prepare("SELECT * FROM events WHERE type = 'suggestion_rejected'").get();
    expect(event).toBeTruthy();
  });

  it('stores project_path in companion event when provided', async () => {
    const dbMod = await import('../../src/lib/db.mjs');
    const db = dbMod.getDb();

    recordFeedback('suggestion-007', 'accepted', {
      projectPath: '/home/user/my-project',
    });

    const event = db.prepare("SELECT * FROM events WHERE type = 'suggestion_applied'").get();
    expect(event.project_path).toBe('/home/user/my-project');
  });
});

// ── getFeedbackSummary ────────────────────────────────────────────────────────

describe('getFeedbackSummary', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('returns null when no feedback has been recorded', async () => {
    const result = await getFeedbackSummary();
    expect(result).toBeNull();
  });

  it('returns correct total, acceptedCount, rejectedCount', async () => {
    recordFeedback('s-1', 'accepted',  { summary: 'skill A' });
    recordFeedback('s-2', 'accepted',  { summary: 'skill B' });
    recordFeedback('s-3', 'rejected',  {});
    recordFeedback('s-4', 'dismissed', {});

    const summary = await getFeedbackSummary();
    expect(summary).not.toBeNull();
    expect(summary.total).toBe(4);
    expect(summary.acceptedCount).toBe(2);
    expect(summary.rejectedCount).toBe(2); // rejected + dismissed
  });

  it('returns correct acceptance rate', async () => {
    recordFeedback('r-1', 'accepted', {});
    recordFeedback('r-2', 'rejected', {});

    const summary = await getFeedbackSummary();
    expect(summary.rate).toBeCloseTo(0.5);
  });

  it('returns rate=1.0 when all feedback is accepted', async () => {
    recordFeedback('a-1', 'accepted', {});
    recordFeedback('a-2', 'accepted', {});

    const summary = await getFeedbackSummary();
    expect(summary.rate).toBe(1.0);
  });

  it('returns rate=0 when all feedback is rejected', async () => {
    recordFeedback('n-1', 'rejected', {});
    recordFeedback('n-2', 'rejected', {});

    const summary = await getFeedbackSummary();
    expect(summary.rate).toBe(0);
  });

  it('recentAcceptances contains summary or suggestion_id labels', async () => {
    recordFeedback('acc-1', 'accepted', { summary: 'My skill summary' });
    recordFeedback('acc-2', 'accepted', {});

    const summary = await getFeedbackSummary();
    expect(summary.recentAcceptances).toContain('My skill summary');
    // acc-2 has no summary → falls back to suggestion_id
    expect(summary.recentAcceptances).toContain('acc-2');
  });

  it('recentAcceptances is capped at 10 entries', async () => {
    for (let i = 0; i < 15; i++) {
      recordFeedback(`bulk-${i}`, 'accepted', { summary: `skill-${i}` });
    }

    const summary = await getFeedbackSummary();
    expect(summary.recentAcceptances.length).toBeLessThanOrEqual(10);
  });

  it('staleSkills is an array (may be empty when no skills are installed)', async () => {
    recordFeedback('st-1', 'accepted', {});

    const summary = await getFeedbackSummary();
    expect(Array.isArray(summary.staleSkills)).toBe(true);
  });
});
