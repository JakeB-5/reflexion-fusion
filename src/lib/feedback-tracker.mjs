// src/lib/feedback-tracker.mjs
// Suggestion feedback recording and analytics

import { getDb, insertEvent } from './db.mjs';

/**
 * Record suggestion feedback (accepted / rejected / dismissed).
 * Also inserts a companion event for activity tracking.
 * @param {string} suggestionId
 * @param {'accepted'|'rejected'|'dismissed'} action
 * @param {{suggestionType?: string, summary?: string, [key: string]: any}} details
 */
export function recordFeedback(suggestionId, action, details = {}) {
  try {
    const db = getDb();
    const ts = new Date().toISOString();

    db.prepare(`
      INSERT INTO feedback (v, ts, suggestion_id, action, suggestion_type, summary)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      ts,
      suggestionId,
      action,
      details.suggestionType || null,
      details.summary || null
    );

    // Companion event for activity tracking
    const eventType = action === 'accepted' ? 'suggestion_applied' : 'suggestion_rejected';
    insertEvent({
      v: 1,
      type: eventType,
      ts,
      session_id: details.sessionId || details.session_id || '',
      project: details.project || null,
      project_path: details.projectPath || details.project_path || null,
      data: { suggestionId, action, ...details },
    });
  } catch {
    // Non-blocking — silently ignore all errors
  }
}

/**
 * Aggregate feedback statistics across all recorded suggestions.
 * @returns {Promise<{
 *   total: number,
 *   acceptedCount: number,
 *   rejectedCount: number,
 *   rate: number,
 *   recentAcceptances: string[],
 *   staleSkills: string[]
 * }|null>}
 */
export async function getFeedbackSummary() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM feedback ORDER BY ts ASC').all();
    if (rows.length === 0) return null;

    const acceptedCount = rows.filter(r => r.action === 'accepted').length;
    const rejectedCount = rows.filter(r => r.action === 'rejected' || r.action === 'dismissed').length;
    const total = rows.length;
    const rate = total > 0 ? acceptedCount / total : 0;

    // Last 10 accepted suggestions (summary or id as label)
    const recentAcceptances = rows
      .filter(r => r.action === 'accepted')
      .slice(-10)
      .map(r => r.summary || r.suggestion_id);

    const staleSkills = await findStaleSkills(30);

    return {
      total,
      acceptedCount,
      rejectedCount,
      rate,
      recentAcceptances,
      staleSkills,
    };
  } catch {
    return null;
  }
}

/**
 * Find skills that have never been used, or were last used more than `days` ago.
 * @param {number} days
 * @returns {Promise<string[]>}
 */
async function findStaleSkills(days = 30) {
  try {
    const db = getDb();
    const threshold = new Date(Date.now() - days * 86400000).toISOString();

    // Dynamically import loadSkills to avoid circular deps at module load time
    let loadSkills;
    try {
      const mod = await import('./skill-matcher.mjs');
      loadSkills = mod.loadSkills;
    } catch {
      return [];
    }

    const skills = loadSkills(process.env.CLAUDE_PROJECT_DIR || null);
    const stale = [];

    for (const skill of skills) {
      const lastUsed = db.prepare(`
        SELECT ts FROM events
        WHERE type = 'skill_used'
          AND json_extract(data, '$.skillName') = ?
        ORDER BY ts DESC LIMIT 1
      `).get(skill.name);

      if (!lastUsed || lastUsed.ts < threshold) {
        stale.push(skill.name);
      }
    }

    return stale;
  } catch {
    return [];
  }
}
