// Mutation ids submitted by THIS Claude Code session, kept on disk so the event poller
// (lib/events.mjs) follows only the changes this session made.
//
//   extractMutationIds(result)      the ids in a successful submit_mutation result
//   createMutationStore(options)    { sessionId, record(ids, loginGeneration), list(), entries(), forget(ids) }
//
// File: <profile>/sessions/<session id>/mutations.json (directory 0700, file 0600, replaced
// atomically). It holds ids, the time each was recorded and the login generation it was submitted
// under, nothing else: at most 20 of them, each kept for 24 h. The session id is CLAUDE_CODE_SESSION_ID, or a random id when that is not set.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './files.mjs';
import { ensureProfileDir } from './store.mjs';

export const MAX_MUTATIONS = 20;
export const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;
const FILE = 'mutations.json';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const IS_WINDOWS = process.platform === 'win32';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// --- reading ids out of a tool result ----------------------------------------------------------

function asId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  return typeof id === 'string' && MUTATION_ID.test(id) ? id : null;
}

/**
 * Ids named by one payload: `id`, `mutation_id`, `mutation_ids[]` and `items[].id`, read at the top
 * level only. A real submit_mutation row also names other mutations (replaces, replaced_by,
 * revision_chain[].id, events); those are not this session's new change, so nothing is searched deeper.
 */
function idsInPayload(payload) {
  if (!isObject(payload)) return [];
  const found = [asId(payload.id), asId(payload.mutation_id)];
  if (Array.isArray(payload.mutation_ids)) found.push(...payload.mutation_ids.map(asId));
  if (Array.isArray(payload.items)) found.push(...payload.items.map(item => (isObject(item) ? asId(item.id) : null)));
  return found.filter(Boolean);
}

function jsonTextBlocks(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => {
    try {
      return JSON.parse(block.text);
    } catch {
      return undefined; // prose, not JSON
    }
  });
}

/** Mutation ids in a submit_mutation CallToolResult: structuredContent, else any JSON text block. Never throws. */
export function extractMutationIds(result) {
  if (!isObject(result) || result.isError === true) return [];
  const fromStructured = idsInPayload(result.structuredContent);
  const ids = fromStructured.length > 0 ? fromStructured : jsonTextBlocks(result).flatMap(idsInPayload);
  return [...new Set(ids)];
}

// --- the per-session file ----------------------------------------------------------------------

export function sessionIdFromEnv(env = process.env) {
  const given = (env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!given) return randomBytes(16).toString('hex');
  // Used as a directory name, so anything that is not plain is replaced by its hash.
  return SESSION_ID.test(given) ? given : createHash('sha256').update(given).digest('hex').slice(0, 32);
}

async function readEntries(path, now, ttlMs) {
  let text;
  try {
    if ((await lstat(path)).isSymbolicLink()) return [];
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed?.mutations) ? parsed.mutations : [];
    return entries.filter(entry => isObject(entry) && asId(entry.id) && Number.isFinite(entry.added_at) && now() - entry.added_at < ttlMs);
  } catch {
    return []; // a damaged file only costs this session its feedback
  }
}

/** <profile>/sessions/<session id>, created (0700) on first use. Also holds the event checkpoints. */
export async function sessionDirectory(env, sessionId) {
  const sessions = join(await ensureProfileDir(env), 'sessions');
  const dir = join(sessions, sessionId);
  for (const level of [sessions, dir]) {
    await mkdir(level, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The session path is not a plain directory.');
  if (!IS_WINDOWS) await chmod(dir, 0o700);
  return dir;
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.sessionId]   default: CLAUDE_CODE_SESSION_ID or a random id
 * @param {() => number} [options.now]   clock, for tests
 * @param {number} [options.ttlMs]
 * @param {number} [options.max]
 */
export function createMutationStore({ env = process.env, sessionId = sessionIdFromEnv(env), now = Date.now, ttlMs = MUTATION_TTL_MS, max = MAX_MUTATIONS } = {}) {
  let queue = Promise.resolve(); // this process is the only writer; keep its own writes in order
  const serialized = task => (queue = queue.then(task, task));

  async function change(update) {
    const dir = await sessionDirectory(env, sessionId);
    const path = join(dir, FILE);
    const next = update(await readEntries(path, now, ttlMs));
    await writePrivateJson(dir, FILE, { version: 1, mutations: next });
    return next;
  }

  return {
    sessionId,
    /**
     * Remember ids (newest last). Keeps at most `max`, dropping the oldest. Resolves the ids now held.
     * `loginGeneration` is the sign-in the ids were submitted under; the event poller ignores ids from another one.
     */
    record: (ids, loginGeneration) => serialized(async () => {
      const wanted = [...new Set(ids)].filter(asId);
      if (wanted.length === 0) return [];
      const next = await change(entries => [
        ...entries.filter(entry => !wanted.includes(entry.id)),
        ...wanted.map(id => ({ id, added_at: now(), ...(Number.isSafeInteger(loginGeneration) ? { login_generation: loginGeneration } : {}) })),
      ].slice(-max));
      return next.map(entry => entry.id);
    }),
    /** { id, added_at, login_generation } for every id still within its 24 h (login_generation is absent on old files). */
    entries: () => serialized(async () => {
      const path = join(await ensureProfileDir(env), 'sessions', sessionId, FILE);
      return (await readEntries(path, now, ttlMs)).map(({ id, added_at, login_generation }) => ({ id, added_at, login_generation }));
    }),
    /** Ids still within their 24 h, oldest first. */
    list: () => serialized(async () => {
      const path = join(await ensureProfileDir(env), 'sessions', sessionId, FILE);
      return (await readEntries(path, now, ttlMs)).map(entry => entry.id);
    }),
    /** Stop following ids (the poller calls this once a change is completed, failed or rejected). */
    forget: ids => serialized(async () => {
      const gone = new Set(ids);
      return (await change(entries => entries.filter(entry => !gone.has(entry.id)))).map(entry => entry.id);
    }),
  };
}

/** Remove session directories nobody has written to for longer than the TTL. Best effort. */
export async function pruneSessions({ env = process.env, now = Date.now, ttlMs = MUTATION_TTL_MS } = {}) {
  try {
    const sessions = join(await ensureProfileDir(env), 'sessions');
    for (const name of await readdir(sessions)) {
      const dir = join(sessions, name);
      // A session is alive while either of its files (ids, event checkpoints) was written recently.
      const files = (await Promise.all([FILE, 'events.json'].map(file => lstat(join(dir, file)).catch(() => null)))).filter(Boolean);
      const infos = files.length > 0 ? files : [await lstat(dir)];
      if (infos.every(info => !info.isSymbolicLink()) && now() - Math.max(...infos.map(info => info.mtimeMs)) > ttlMs) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // no sessions directory yet, or a race with another process: nothing to prune
  }
}
