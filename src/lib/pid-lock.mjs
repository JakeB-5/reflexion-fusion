// Atomic PID-file lock using O_EXCL for single-instance enforcement
import { openSync, writeSync, closeSync, readFileSync, rmSync, constants } from 'node:fs';

export function acquirePidLock(pidPath) {
  if (_tryCreate(pidPath)) return true;

  let holderPid;
  try {
    holderPid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  } catch {
    try { rmSync(pidPath, { force: true }); } catch {}
    return _tryCreate(pidPath);
  }

  if (!holderPid || isNaN(holderPid)) {
    try { rmSync(pidPath, { force: true }); } catch {}
    return _tryCreate(pidPath);
  }

  try {
    process.kill(holderPid, 0);
    return false; // holder alive — defer
  } catch {
    try { rmSync(pidPath, { force: true }); } catch {}
    return _tryCreate(pidPath);
  }
}

export function releasePidLock(pidPath) {
  try { rmSync(pidPath); } catch { /* ignore */ }
}

function _tryCreate(pidPath) {
  try {
    const fd = openSync(pidPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
