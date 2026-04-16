// Embedding client — connects to the Unix socket embedding daemon
// Auto-starts the daemon on first use, retries once on connection failure

import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SOCKET_PATH = '/tmp/reflexion-fusion-embed.sock';
const EMBED_TIMEOUT_MS = 10000; // 10 seconds
const HEALTH_TIMEOUT_MS = 500;  // 500 ms for quick health probe

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'embedding-server.mjs');

// Send a single JSON request over the socket and resolve with parsed response
function _sendRequest(payload) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    let data = '';

    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('Embedding server timeout'));
    }, EMBED_TIMEOUT_MS);

    conn.on('connect', () => {
      conn.write(JSON.stringify(payload) + '\n');
    });

    conn.on('data', (chunk) => { data += chunk; });

    conn.on('end', () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(data.trim());
        resolve(res);
      } catch (e) {
        reject(new Error(`Invalid JSON response: ${e.message}`));
      }
    });

    conn.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Check whether the embedding daemon is reachable and healthy
export async function isServerRunning() {
  return new Promise((resolve) => {
    const conn = createConnection(SOCKET_PATH);
    let data = '';

    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, HEALTH_TIMEOUT_MS);

    conn.on('connect', () => {
      conn.write(JSON.stringify({ action: 'health' }) + '\n');
    });

    conn.on('data', (chunk) => { data += chunk; });

    conn.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.trim()).status === 'ok');
      } catch {
        resolve(false);
      }
    });

    conn.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Spawn the embedding server as a detached background process (no-op if already running)
export async function startServer() {
  if (await isServerRunning()) return;
  const child = spawn('node', [SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// Request embeddings for an array of text strings (auto-starts server if needed)
export async function embedViaServer(texts) {
  try {
    const res = await _sendRequest({ action: 'embed', texts });
    if (res.embeddings) return res.embeddings;
    throw new Error(res.error || 'No embeddings returned');
  } catch (e) {
    // On connection failure, start server and retry once
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
      await startServer();
      // Wait for daemon to initialize
      await new Promise((r) => setTimeout(r, 5000));
      const res = await _sendRequest({ action: 'embed', texts });
      if (res.embeddings) return res.embeddings;
      throw new Error(res.error || 'No embeddings returned');
    }
    throw e;
  }
}
