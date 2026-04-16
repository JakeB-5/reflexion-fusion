// Embedding daemon — Unix socket server for offline 384-dim ML embeddings
// Loads Xenova/paraphrase-multilingual-MiniLM-L12-v2, handles embed/health actions
// Auto-shuts down after 30 minutes of idle

import { createServer, createConnection } from 'node:net';
import { existsSync, unlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline, env } from '@xenova/transformers';

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

function healthCheck() {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) return resolve(false);
    const conn = createConnection(SOCKET_PATH);
    const timer = setTimeout(() => { conn.destroy(); resolve(false); }, 1000);
    conn.on('connect', () => {
      conn.write(JSON.stringify({ action: 'health' }) + '\n');
    });
    let data = '';
    conn.on('data', (chunk) => { data += chunk; });
    conn.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.trim()).status === 'ok'); }
      catch { resolve(false); }
    });
    conn.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function killStalePid() {
  if (!existsSync(PID_PATH)) return;
  try {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
    if (pid && !isNaN(pid)) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGTERM'); }
      catch { /* already dead */ }
    }
  } catch { /* corrupt pid file */ }
  try { rmSync(PID_PATH); } catch { /* ignore */ }
}

function writePidFile() {
  writeFileSync(PID_PATH, String(process.pid), 'utf8');
}

function cleanupPidFile() {
  try { rmSync(PID_PATH); } catch { /* ignore */ }
}

// Defer to existing healthy instance
if (await healthCheck()) {
  process.stderr.write('[embedding-server] Healthy instance already running. Exiting.\n');
  process.exit(0);
}

// No healthy instance — clean up stale state
killStalePid();
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

await init();
writePidFile();

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
    cleanupPidFile();
    process.exit(0);
  }
  throw e;
});

server.listen(SOCKET_PATH, () => {
  process.stderr.write(`[embedding-server] Listening on ${SOCKET_PATH}\n`);
  resetIdleTimer(server);
});

const shutdown = () => { cleanupPidFile(); server.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
