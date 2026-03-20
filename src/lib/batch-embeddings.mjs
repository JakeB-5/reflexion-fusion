// Detached batch embedding processor — called from session-summary hook
// Generates embeddings for error_kb entries missing vec entries
// Exits 0 always (non-blocking, non-critical background task)

import { getDb, EMBEDDING_DIM } from './db.mjs';
import { embedViaServer, isServerRunning, startServer } from './embedding-client.mjs';

try {
  // 10s startup delay to reduce DB write contention with the session hook.
  // WAL mode + busy_timeout handle the remaining concurrency; this delay
  // merely reduces the frequency of busy retries in the common case.
  await new Promise((r) => setTimeout(r, 10000));

  const db = getDb();

  // Extended busy timeout for concurrent writes from other hooks
  db.pragma('busy_timeout = 10000');

  // Wait for the embedding daemon to be ready (up to 15 seconds)
  let running = await isServerRunning();
  if (!running) {
    await startServer();
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      running = await isServerRunning();
      if (running) break;
    }
  }

  if (!running) {
    // Daemon failed to start — exit gracefully without embedding
    process.exit(0);
  }

  // --- Error KB: batch-generate embeddings for entries without vec rows ---
  const missing = db.prepare(`
    SELECT id, error_normalized FROM error_kb
    WHERE id NOT IN (SELECT error_kb_id FROM vec_error_kb)
  `).all();

  if (missing.length > 0) {
    const texts = missing.map((r) => r.error_normalized);
    const embeddings = await embedViaServer(texts);

    for (let i = 0; i < missing.length; i++) {
      if (!embeddings[i]) continue; // Skip failed or null embeddings

      const blob = Buffer.from(new Float32Array(embeddings[i]).buffer);
      const eid = Number(missing[i].id);

      // REPLACE pattern: delete then insert (vec0 does not support UPDATE)
      db.prepare('DELETE FROM vec_error_kb WHERE error_kb_id = ?').run(eid);
      db.prepare('INSERT INTO vec_error_kb (error_kb_id, embedding) VALUES (?, ?)').run(eid, blob);
    }
  }

  // --- Skill embeddings: refresh all skill_embeddings entries ---
  // skill-matcher.mjs does not exist yet; this section will be populated
  // once loadSkills/extractPatterns are available in reflexion-fusion.

  process.exit(0);
} catch {
  // Batch embedding is non-critical — always exit cleanly
  process.exit(0);
}
