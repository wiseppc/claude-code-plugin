// Small private-file helper shared by the per-profile caches: replace a JSON file atomically
// (temp file, fsync, rename) with mode 0600, so a reader sees the old file or the new one.
import { randomBytes } from 'node:crypto';
import { open, rename as fsRename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Windows refuses to rename over (or read) a file another handle has open; these codes mean "try again shortly". */
export const isBusyError = error => BUSY_CODES.has(error?.code);

/**
 * Run an fs operation, retrying EPERM/EACCES/EBUSY with a short capped backoff (default 10 tries,
 * at most maxMs in total). Any other error, or the last busy error, is rethrown unchanged.
 */
export async function retryBusy(operation, { attempts = 10, maxMs = 2000, wait = sleep } = {}) {
  const deadline = Date.now() + maxMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusyError(error) || attempt >= attempts || Date.now() >= deadline) throw error;
      await wait(Math.min(20 * 2 ** (attempt - 1), 250, Math.max(0, deadline - Date.now())));
    }
  }
}

/** rename() that survives a transient sharing violation. `rename` and `wait` can be injected for tests. */
export function renameWithRetry(from, to, { rename = fsRename, ...retry } = {}) {
  return retryBusy(() => rename(from, to), retry);
}

export async function writePrivateJson(dir, name, value, options = {}) {
  const temp = join(dir, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, join(dir, name), options);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
