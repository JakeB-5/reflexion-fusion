// Embedding daemon — Unix socket server for offline 384-dim ML embeddings
// Loads Xenova/paraphrase-multilingual-MiniLM-L12-v2, handles embed/health actions
// Auto-shuts down after 30 minutes of idle

import { createServer } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline, env } from '@xenova/transformers';
import { acquirePidLock, releasePidLock } from './pid-lock.mjs';

const SOCKET_PATH = '/tmp/reflexion-fusion-embed.sock';
const PID_PATH = '/tmp/reflexion-fusion-embed.pid';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MODELS_DIR = join(process.env.HOME || '', '.reflexion-fusion', 'models');

let extractor = null;
let idleTimer = null;

function resetIdleTimer(server) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    process.stderr.write('[embedding-server] Idle timeout reached, shutting down\n');
    server.close();
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

async function embed(texts) {
  const results = [];
  for (const text of texts) {
    if (!text || !text.trim()) {
      results.push(null);
      continue;
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(output.data);
    // Reject vectors containing non-finite values
    results.push(vec.every(v => isFinite(v)) ? vec : null);
  }
  return results;
}

async function init() {
  process.stderr.write('[embedding-server] Loading model...\n');
  env.cacheDir = MODELS_DIR;
  extractor = await pipeline(
    'feature-extraction',
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
  );
  process.stderr.write('[embedding-server] Model ready\n');
}

// Atomic single-instance gate — must succeed before any startup work
if (!acquirePidLock(PID_PATH)) {
  process.stderr.write('[embedding-server] Another instance holds the lock. Exiting.\n');
  process.exit(0);
}

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

await init();

const server = createServer((conn) => {
  resetIdleTimer(server);
  let data = '';

  conn.on('data', (chunk) => { data += chunk; });

  conn.on('end', async () => {
    try {
      const req = JSON.parse(data.trim());

      if (req.action === 'health') {
        conn.end(JSON.stringify({ status: 'ok' }) + '\n');
      } else if (req.action === 'embed') {
        const embeddings = await embed(req.texts || []);
        conn.end(JSON.stringify({ embeddings }) + '\n');
      } else {
        conn.end(JSON.stringify({ error: 'unknown action' }) + '\n');
      }
    } catch (e) {
      try { conn.end(JSON.stringify({ error: e.message }) + '\n'); } catch { /* ignore */ }
    }
  });

  conn.on('error', () => { /* ignore client disconnect errors */ });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write('[embedding-server] Socket already in use, another instance running. Exiting.\n');
    releasePidLock(PID_PATH);
    process.exit(0);
  }
  throw e;
});

server.listen(SOCKET_PATH, () => {
  process.stderr.write(`[embedding-server] Listening on ${SOCKET_PATH}\n`);
  resetIdleTimer(server);
});

const shutdown = () => { releasePidLock(PID_PATH); server.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
