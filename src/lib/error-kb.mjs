// src/lib/error-kb.mjs
// Error Knowledge Base — normalize error text, 3-stage search, record resolutions

import { getDb, vectorSearch, generateEmbeddings } from './db.mjs';

/**
 * Normalize error text for deduplication and search.
 * Replaces quoted strings → <STR>, file paths → <PATH>, multi-digit numbers → <N>.
 * Truncates to 200 chars.
 * @param {string} error
 * @returns {string}
 */
export function normalizeError(error) {
  if (!error) return '';

  let normalized = String(error);

  // Step 1: Replace quoted strings (≤100 chars) first — handles quoted paths too
  normalized = normalized.replace(/"([^"]{1,100})"/g, '<STR>');
  normalized = normalized.replace(/'([^']{1,100})'/g, '<STR>');

  // Step 2: Replace file paths starting with / or ./
  normalized = normalized.replace(/\/[^\s]+/g, '<PATH>');
  normalized = normalized.replace(/\.[/\\][^\s]+/g, '<PATH>');

  // Step 3: Replace 2+ digit numbers
  normalized = normalized.replace(/\d{2,}/g, '<N>');

  return normalized.slice(0, 200).trim();
}

/**
 * Search error KB using 3-stage fallback: exact → prefix → vector.
 * @param {string} normalizedError
 * @returns {Promise<{error_normalized, resolution, resolved_by, tool_sequence, use_count}|null>}
 */
export async function searchErrorKB(normalizedError) {
  if (!normalizedError) return null;

  try {
    const db = getDb();
    const now = new Date().toISOString();

    // Stage 1: Exact match
    const exact = db.prepare(`
      SELECT * FROM error_kb
      WHERE error_normalized = ? AND resolution IS NOT NULL
      ORDER BY use_count DESC, ts DESC
      LIMIT 1
    `).get(normalizedError);

    if (exact) {
      db.prepare(`
        UPDATE error_kb SET use_count = use_count + 1, last_used = ? WHERE id = ?
      `).run(now, exact.id);
      return db.prepare('SELECT * FROM error_kb WHERE id = ?').get(exact.id);
    }

    // Stage 2: Prefix match — first 30 chars + length ratio >= 0.7
    const prefix = normalizedError.slice(0, 30);
    const minLen = Math.floor(normalizedError.length * 0.7);
    const maxLen = Math.ceil(normalizedError.length / 0.7);

    const prefixRows = db.prepare(`
      SELECT * FROM error_kb
      WHERE error_normalized LIKE ? || '%'
        AND resolution IS NOT NULL
        AND LENGTH(error_normalized) BETWEEN ? AND ?
      ORDER BY use_count DESC, ts DESC
    `).all(prefix, minLen, maxLen);

    if (prefixRows.length > 0) {
      const match = prefixRows[0];
      db.prepare(`
        UPDATE error_kb SET use_count = use_count + 1, last_used = ? WHERE id = ?
      `).run(now, match.id);
      return db.prepare('SELECT * FROM error_kb WHERE id = ?').get(match.id);
    }

    // Stage 3: Vector similarity search
    const embeddings = await generateEmbeddings([normalizedError]);
    if (!embeddings || embeddings.length === 0) return null;

    const results = vectorSearch('error_kb', 'vec_error_kb', embeddings[0], 3);
    const withResolution = results.filter(r => r.resolution != null);
    if (withResolution.length === 0) return null;

    const best = withResolution[0];

    // Reject if too dissimilar
    if (best.distance >= 0.85) return null;

    // High confidence: accept directly
    if (best.distance < 0.76) {
      db.prepare(`
        UPDATE error_kb SET use_count = use_count + 1, last_used = ? WHERE id = ?
      `).run(now, best.id);
      return db.prepare('SELECT * FROM error_kb WHERE id = ?').get(best.id);
    }

    // Medium confidence (0.76–0.85): require at least one shared keyword (3+ chars)
    const queryWords = normalizedError.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    const matchWords = best.error_normalized.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    const hasCommon = queryWords.some(w => matchWords.includes(w));
    if (!hasCommon) return null;

    db.prepare(`
      UPDATE error_kb SET use_count = use_count + 1, last_used = ? WHERE id = ?
    `).run(now, best.id);
    return db.prepare('SELECT * FROM error_kb WHERE id = ?').get(best.id);

  } catch {
    return null;
  }
}

/**
 * UPSERT an error resolution into the KB.
 * On conflict (same error_normalized), increments use_count and updates all fields.
 * @param {string} normalizedError
 * @param {{errorRaw?: string, error_raw?: string, resolvedBy?: string, resolved_by?: string, toolSequence?: any, tool_sequence?: any}} details
 */
export function recordResolution(normalizedError, details) {
  if (!normalizedError || !details) return;

  try {
    const db = getDb();
    const ts = new Date().toISOString();

    // Accept both camelCase and snake_case field names
    const errorRaw = details.errorRaw || details.error_raw || null;
    const resolvedBy = details.resolvedBy || details.resolved_by || null;
    const toolSequence = details.toolSequence || details.tool_sequence || null;
    const toolSeqStr = Array.isArray(toolSequence)
      ? JSON.stringify(toolSequence)
      : toolSequence || null;

    db.prepare(`
      INSERT INTO error_kb (ts, error_normalized, error_raw, resolution, resolved_by, tool_sequence, use_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(error_normalized) DO UPDATE SET
        ts = excluded.ts,
        error_raw = excluded.error_raw,
        resolution = excluded.resolution,
        resolved_by = excluded.resolved_by,
        tool_sequence = excluded.tool_sequence,
        use_count = use_count + 1
    `).run(
      ts,
      normalizedError,
      errorRaw,
      JSON.stringify(details),
      resolvedBy,
      toolSeqStr
    );
  } catch {
    // Non-blocking — silently ignore all errors
  }
}
