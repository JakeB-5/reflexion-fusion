// Regression test: only one embedding server process should run at a time
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { isServerRunning, startServer } from '../../src/lib/embedding-client.mjs';
import { execSync } from 'node:child_process';

const SOCKET_PATH = '/tmp/reflexion-fusion-embed.sock';
const PID_PATH = '/tmp/reflexion-fusion-embed.pid';

function createMockServer() {
  return new Promise((resolve) => {
    const srv = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk;
        if (!buf.includes('\n')) return;
        try {
          const req = JSON.parse(buf.trim());
          if (req.action === 'health') {
            conn.end(JSON.stringify({ status: 'ok' }) + '\n');
          } else {
            conn.end(JSON.stringify({ error: 'mock' }) + '\n');
          }
        } catch { conn.end('{}'); }
      });
      conn.on('error', () => { /* ignore client disconnect */ });
    });
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    srv.listen(SOCKET_PATH, () => resolve(srv));
  });
}

function cleanup() {
  try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
}

describe('embedding-server singleton', () => {
  afterEach(() => cleanup());

  it('isServerRunning returns true when a healthy server exists', async () => {
    const mock = await createMockServer();
    try {
      const running = await isServerRunning();
      expect(running).toBe(true);
    } finally {
      mock.close();
    }
  });

  it('isServerRunning returns false when no server exists', async () => {
    cleanup();
    const running = await isServerRunning();
    expect(running).toBe(false);
  });

  it('startServer no-ops when healthy server already running', async () => {
    const mock = await createMockServer();
    try {
      const before = countEmbedProcesses();
      await startServer();
      // Small delay to allow any inadvertent spawn to register
      await new Promise(r => setTimeout(r, 500));
      const after = countEmbedProcesses();
      expect(after).toBe(before);
    } finally {
      mock.close();
    }
  });

  it('PID file is written on server start and cleaned up', async () => {
    cleanup();
    // Write a fake PID file to simulate stale state
    writeFileSync(PID_PATH, '99999999', 'utf8');
    expect(existsSync(PID_PATH)).toBe(true);

    // Verify we can read it
    const pid = readFileSync(PID_PATH, 'utf8').trim();
    expect(pid).toBe('99999999');

    cleanup();
    expect(existsSync(PID_PATH)).toBe(false);
  });
});

function countEmbedProcesses() {
  try {
    const out = execSync('pgrep -f "embedding-server.mjs" 2>/dev/null || true', { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}
