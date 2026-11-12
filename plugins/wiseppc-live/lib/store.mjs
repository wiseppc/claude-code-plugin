// Per-profile credential storage for wiseppc-live, on Node built-ins only.
//
// Layout: ~/.wiseppc/claude-code/profiles/<profile>/   (directory 0700)
//           oauth.json   (file 0600): client registration, tokens, expiry, counters
//           oauth.lock   (file 0600): cross-process lock, held only while refreshing or writing
//
// Rules this module enforces:
// - The profile directory and oauth.json are never followed through a symlink.
// - oauth.json is replaced atomically (temp file, fsync, rename), so a reader sees the old file or
//   the new one, never a partial write.
// - The lock is a file created with O_EXCL. A lock is stale after 60 s, or when its owner is a dead
//   process on this host. Stale locks are stolen by renaming them away.
// This is unsafe on NFS home directories (O_EXCL is not reliable there); the plan accepts that.

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { renameWithRetry, retryBusy } from './files.mjs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_MCP_URL = 'https://mcp.wiseppc.com/mcp';
export const STATE_FILE = 'oauth.json';
export const LOCK_FILE = 'oauth.lock';
const IS_WINDOWS = process.platform === 'win32';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Test seam: replaces the rename (and its backoff wait) used by writeState when a caller passes none. */
export const testHooks = { rename: undefined, wait: undefined };

export class StoreError extends Error {}
export class LockTimeoutError extends Error {}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** WISEPPC_LIVE_PROFILE, default "default". Restricted so it can only name a directory. */
export function profileName(env = process.env) {
  const name = (env.WISEPPC_LIVE_PROFILE ?? '').trim() || 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new StoreError('WISEPPC_LIVE_PROFILE may only contain letters, digits, dot, dash and underscore (max 64).');
  }
  return name;
}

/** WISEPPC_LIVE_MCP_URL, default production. https only, except http on a loopback host (used by tests). */
export function mcpUrl(env = process.env) {
  const raw = (env.WISEPPC_LIVE_MCP_URL ?? '').trim() || DEFAULT_MCP_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError('WISEPPC_LIVE_MCP_URL is not a valid URL.');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
    throw new StoreError('WISEPPC_LIVE_MCP_URL must be an https URL without credentials, query or fragment.');
  }
  return url;
}

export function profileDir(env = process.env) {
  return join(homedir(), '.wiseppc', 'claude-code', 'profiles', profileName(env));
}

/** Create the profile directory chain (each new level 0700) and force the profile directory to 0700. */
export async function ensureProfileDir(env = process.env) {
  const dir = profileDir(env);
  const levels = [join(homedir(), '.wiseppc'), join(homedir(), '.wiseppc', 'claude-code'), join(homedir(), '.wiseppc', 'claude-code', 'profiles'), dir];
  for (const level of levels) {
    try {
      await mkdir(level, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StoreError('The profile path is not a plain directory; refusing to use it.');
  if (!IS_WINDOWS) await chmod(dir, 0o700);
  return dir;
}

export const emptyState = () => ({ version: 1, generation: 0, login_generation: 0 });
export const isSignedIn = state => typeof state.access_token === 'string' && typeof state.refresh_token === 'string';

/** Read oauth.json. A missing file is an empty state; a symlink or non-file is an error. */
export async function readState(env = process.env) {
  const path = join(profileDir(env), STATE_FILE);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new StoreError(`${STATE_FILE} is not a regular file; refusing to read it.`);
  // readFile opens, reads and closes in one call, so no handle outlives the read (on Windows an open
  // handle makes a concurrent rename-over fail). A read that collides with a rename is retried.
  let text;
  try {
    text = await retryBusy(() => readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }), { attempts: 6, maxMs: 500 });
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState(); // replaced between the lstat and the read
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { ...emptyState(), ...parsed };
  } catch {
    throw new StoreError(`${STATE_FILE} is unreadable. Run wiseppc_live_logout, then sign in again.`);
  }
}

/**
 * Replace oauth.json atomically. Call under the lock when the new value depends on the old one.
 * The rename is retried on EPERM/EACCES/EBUSY (Windows, while another handle is open); if it still
 * fails the temp file is removed and the error is thrown. `options.rename` / `options.wait` are test hooks.
 */
export async function writeState(state, env = process.env, options = {}) {
  const dir = await ensureProfileDir(env);
  const path = join(dir, STATE_FILE);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new StoreError(`${STATE_FILE} is not a regular file; refusing to replace it.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = join(dir, `${STATE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(temp, path, { ...options, rename: options.rename ?? testHooks.rename, wait: options.wait ?? testHooks.wait });
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  if (!IS_WINDOWS) {
    // Persist the rename itself. Best effort: not every filesystem lets a directory be opened.
    const dirHandle = await open(dir, constants.O_RDONLY).catch(() => null);
    await dirHandle?.sync().catch(() => {});
    await dirHandle?.close();
  }
}

// --- cross-process lock ------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but belongs to another user
  }
}

async function readLock(path) {
  let text;
  let mtimeMs;
  try {
    [text, mtimeMs] = [await readFile(path, 'utf8'), (await lstat(path)).mtimeMs];
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const lock = JSON.parse(text);
    return { pid: lock.pid, host: lock.host, nonce: lock.nonce, ts: Number(lock.ts), mtimeMs };
  } catch {
    // Created but not yet written (or damaged): judge it by file age alone.
    return { pid: undefined, host: undefined, nonce: undefined, ts: mtimeMs, mtimeMs };
  }
}

function isStale(lock, staleMs) {
  if (Date.now() - lock.ts > staleMs) return true;
  return lock.host === hostname() && lock.pid !== undefined && !pidAlive(lock.pid);
}

/** Move a stale lock aside. If it turns out to be a fresh lock someone just created, put it back. */
async function stealLock(path, seen) {
  const aside = `${path}.stale.${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return; // someone else already removed it
    throw error;
  }
  const taken = await readLock(aside);
  if (taken && taken.nonce !== seen.nonce) {
    // We moved a lock that is not the stale one. Restore it unless a new lock already exists.
    await open(path, 'wx', 0o600).then(async handle => {
      await handle.writeFile(JSON.stringify({ pid: taken.pid, host: taken.host, nonce: taken.nonce, ts: taken.ts }));
      await handle.close();
    }).catch(() => {});
  }
  await unlink(aside).catch(() => {});
}

/**
 * Run fn while holding oauth.lock. fn receives { stillHeld } to re-check ownership before an
 * irreversible step (the lock could have been stolen if fn ran longer than staleMs).
 */
export async function withLock(fn, { waitMs = 30_000, staleMs = 60_000, env = process.env } = {}) {
  const dir = await ensureProfileDir(env);
  const path = join(dir, LOCK_FILE);
  const nonce = randomBytes(12).toString('hex');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce, ts: Date.now() }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await readLock(path))?.nonce === nonce) break; // re-read: confirm no one stole it in between
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const seen = await readLock(path);
    if (seen && isStale(seen, staleMs)) {
      await stealLock(path, seen);
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError('Timed out waiting for another WisePPC Live process to finish refreshing the sign-in.');
    await sleep(100 + Math.random() * 400);
  }
  try {
    return await fn({ stillHeld: async () => (await readLock(path))?.nonce === nonce });
  } finally {
    if ((await readLock(path).catch(() => null))?.nonce === nonce) await unlink(path).catch(() => {});
  }
}

/** Read-modify-write oauth.json under the lock. mutate(state) returns the new state. */
export async function updateState(mutate, options = {}) {
  return withLock(async () => {
    const next = await mutate(await readState(options.env));
    await writeState(next, options.env, options);
    return next;
  }, options);
}
