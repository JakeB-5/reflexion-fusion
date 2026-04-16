// Regression test: only one embedding server process should run at a time
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { exec, execSync } from 'node:child_process';
import { acquirePidLock, releasePidLock } from '../../src/lib/pid-lock.mjs';
import { isServerRunning, startServer } from '../../src/lib/embedding-client.mjs';

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
      conn.on('error', () => {});
    });
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    srv.listen(SOCKET_PATH, () => resolve(srv));
  });
}

function cleanup() {
  try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
}

function countEmbedProcesses() {
  try {
    const out = execSync('pgrep -f "embedding-server.mjs" 2>/dev/null || true', { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

describe('pid-lock', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('acquires lock on clean state', () => {
    expect(acquirePidLock(PID_PATH)).toBe(true);
    expect(existsSync(PID_PATH)).toBe(true);
    expect(readFileSync(PID_PATH, 'utf8').trim()).toBe(String(process.pid));
  });

  it('rejects when holder is alive', () => {
    writeFileSync(PID_PATH, String(process.pid), 'utf8');
    expect(acquirePidLock(PID_PATH)).toBe(false);
  });

  it('steals lock from dead holder', () => {
    writeFileSync(PID_PATH, '99999999', 'utf8');
    expect(acquirePidLock(PID_PATH)).toBe(true);
    expect(readFileSync(PID_PATH, 'utf8').trim()).toBe(String(process.pid));
  });

  it('steals lock from corrupt PID file', () => {
    writeFileSync(PID_PATH, 'not-a-number', 'utf8');
    expect(acquirePidLock(PID_PATH)).toBe(true);
  });

  it('steals lock from empty PID file', () => {
    writeFileSync(PID_PATH, '', 'utf8');
    expect(acquirePidLock(PID_PATH)).toBe(true);
  });

  it('releases lock', () => {
    acquirePidLock(PID_PATH);
    expect(existsSync(PID_PATH)).toBe(true);
    releasePidLock(PID_PATH);
    expect(existsSync(PID_PATH)).toBe(false);
  });

  it('concurrent O_EXCL attempts yield exactly one winner', async () => {
    const tmpScript = '/tmp/reflexion-fusion-lock-test.cjs';
    writeFileSync(tmpScript, `
      const { openSync, writeSync, closeSync, constants } = require('fs');
      try {
        const fd = openSync('${PID_PATH}', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        process.stdout.write('won');
      } catch (e) {
        process.stdout.write(e.code === 'EEXIST' ? 'lost' : 'error:' + e.code);
      }
    `);

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise((resolve) => {
          exec(`node ${tmpScript}`, (err, stdout) => {
            resolve(stdout.trim());
          });
        })
      )
    );

    try { unlinkSync(tmpScript); } catch {}

    expect(results.filter(r => r === 'won').length).toBe(1);
    expect(results.filter(r => r === 'lost').length).toBe(N - 1);
    expect(results.filter(r => r.startsWith('error')).length).toBe(0);
  }, 15000);
});

describe('embedding-server singleton', () => {
  beforeEach(() => cleanup());
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
    const running = await isServerRunning();
    expect(running).toBe(false);
  });

  it('startServer no-ops when healthy server already running', async () => {
    const mock = await createMockServer();
    try {
      const before = countEmbedProcesses();
      await startServer();
      await new Promise(r => setTimeout(r, 500));
      const after = countEmbedProcesses();
      expect(after).toBe(before);
    } finally {
      mock.close();
    }
  });
});
