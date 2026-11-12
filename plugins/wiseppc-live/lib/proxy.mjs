// The proxy layer of wiseppc-live: puts the three local sign-in tools and the remote WisePPC tools
// behind one MCP server.
//
// - tools/list: the local tools, then the remote tools exactly as the server sent them. A remote tool
//   with a local tool's name is dropped (the local one wins) and a warning goes to stderr.
// - tools/call: a local name runs locally; every other name is forwarded and the result comes back
//   verbatim (content, structuredContent, isError).
// - Signed out, or the server unreachable: tools/list still answers at once with the local tools plus
//   the remote list cached from the last session, and a remote call returns an isError result that
//   says what to do. Nothing here blocks on the network for longer than one request timeout.
// - When the sign-in changes (this process or another one), the remote session is dropped and
//   notifications/tools/list_changed is sent.
// - Every successful submit_mutation records its mutation ids (and the login generation) in this
//   session's store (lib/mutations.mjs) and tells `onMutationRecorded`, so the event poller follows it.
// - The remote server's own `instructions` are cached next to the tool list (remote-instructions.json),
//   so the next session can hand them to Claude Code in its own initialize reply.
import { readFileSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './files.mjs';
import { createMutationStore, extractMutationIds } from './mutations.mjs';
import { OAuthError, SignedOutError } from './oauth.mjs';
import { CALL_TIMEOUT_MS, RemoteError } from './remote.mjs';
import { STATE_FILE, ensureProfileDir, isSignedIn, profileDir, readState } from './store.mjs';

const CACHE_FILE = 'remote-tools.json';
const INSTRUCTIONS_FILE = 'remote-instructions.json';
export const MAX_INSTRUCTIONS_CHARS = 32 * 1024;
const SIGN_IN_HINT = 'Run wiseppc_live_login to sign in to WisePPC.';

const text = (message, isError = false) => ({ content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) });
const isTool = value => value !== null && typeof value === 'object' && typeof value.name === 'string';

/** A tool-call failure rewritten for the model: what happened, and what to do about it. */
export function describeRemoteFailure(error) {
  if (error instanceof SignedOutError) return error.message; // already says to run wiseppc_live_login
  if (error instanceof OAuthError) return `Could not refresh the WisePPC sign-in right now (${error.message}). Try again in a moment.`;
  if (error instanceof RemoteError) {
    switch (error.kind) {
      case 'unauthorized': return `WisePPC rejected the stored sign-in. ${SIGN_IN_HINT}`;
      case 'rate_limited': return error.message;
      case 'rpc': return `WisePPC returned an error${error.code === undefined ? '' : ` (${error.code})`}: ${error.message}`;
      case 'forbidden': return 'WisePPC refused the request (HTTP 403). The connection may not be allowed to do this.';
      default: return error.message;
    }
  }
  return 'The WisePPC request failed unexpectedly. Try again.';
}

/**
 * @param {object} options
 * @param {object[]} options.localTools                 the local tool definitions
 * @param {(name: string) => Promise<object | null>} options.callLocal   null when the name is not local
 * @param {ReturnType<import('./remote.mjs').createRemote>} options.remote
 * @param {() => void} options.toolsChanged             sends notifications/tools/list_changed
 * @param {string} options.origin                       the server origin; a cached list is only used for the same one
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {ReturnType<typeof createMutationStore>} [options.mutations]
 * @param {() => void} [options.onMutationRecorded]    called after ids were stored (wakes the event poller)
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.pollMs]                     how often to re-check the sign-in file besides fs.watch
 */
export function createProxy(options) {
  const {
    localTools,
    callLocal,
    remote,
    toolsChanged,
    origin,
    env = process.env,
    mutations = createMutationStore({ env }),
    onMutationRecorded = () => {},
    log = () => {},
    pollMs = 3000,
  } = options;
  const localNames = new Set(localTools.map(tool => tool.name));
  const warned = new Set();

  // --- the cached remote list --------------------------------------------------------------------

  async function readCache() {
    try {
      const cache = JSON.parse(await readFile(join(await ensureProfileDir(env), CACHE_FILE), 'utf8'));
      return cache?.origin === origin && Array.isArray(cache.tools) ? cache.tools.filter(isTool) : [];
    } catch {
      return [];
    }
  }

  async function writeCache(tools) {
    try {
      await writePrivateJson(await ensureProfileDir(env), CACHE_FILE, { version: 1, origin, tools });
    } catch (error) {
      log(`could not cache the tool list: ${error.message}`);
    }
  }

  // --- the cached server instructions --------------------------------------------------------------

  /** The instructions the remote server sent last time (same origin only), or ''. Synchronous: initialize cannot wait. */
  function cachedInstructions() {
    try {
      const cache = JSON.parse(readFileSync(join(profileDir(env), INSTRUCTIONS_FILE), 'utf8'));
      return cache?.origin === origin && typeof cache.instructions === 'string' && cache.instructions.length <= MAX_INSTRUCTIONS_CHARS ? cache.instructions : '';
    } catch {
      return '';
    }
  }

  /** Keep the server's instructions for the next session. Never throws. */
  async function rememberInstructions(instructions) {
    if (typeof instructions !== 'string' || !instructions || instructions.length > MAX_INSTRUCTIONS_CHARS) return;
    if (instructions === cachedInstructions()) return;
    try {
      await writePrivateJson(await ensureProfileDir(env), INSTRUCTIONS_FILE, { version: 1, origin, instructions });
    } catch (error) {
      log(`could not cache the server instructions: ${error.message}`);
    }
  }

  // --- tools/list --------------------------------------------------------------------------------

  /** The remote page, or null when it cannot be had (signed out, offline, rate limited, ...). */
  async function fetchRemotePage(params) {
    try {
      const page = await remote.request('tools/list', params);
      if (!Array.isArray(page?.tools)) throw new RemoteError('The WisePPC tool list was malformed.', { kind: 'protocol' });
      return page;
    } catch (error) {
      if (!(error instanceof SignedOutError)) log(`remote tools/list failed: ${error.message}`);
      return null;
    }
  }

  function withoutCollisions(tools) {
    return tools.filter(tool => {
      if (!localNames.has(tool.name)) return true;
      if (!warned.has(tool.name)) {
        warned.add(tool.name);
        log(`warning: the remote tool "${tool.name}" has the same name as a local wiseppc-live tool; the local tool is used`);
      }
      return false;
    });
  }

  async function listTools(params = {}) {
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    const page = await fetchRemotePage(cursor === undefined ? undefined : { cursor });
    if (page) {
      // Only a complete list (one page) is worth keeping for the next signed-out session.
      if (cursor === undefined && page.nextCursor === undefined) void writeCache(page.tools);
      return { tools: [...(cursor === undefined ? localTools : []), ...withoutCollisions(page.tools)], ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}) };
    }
    if (cursor !== undefined) return { tools: [] };
    return { tools: [...localTools, ...withoutCollisions(await readCache())] };
  }

  // --- tools/call --------------------------------------------------------------------------------

  async function recordMutations(result) {
    const ids = extractMutationIds(result);
    if (ids.length === 0) return;
    try {
      await mutations.record(ids, (await readState(env)).login_generation);
      onMutationRecorded();
    } catch (error) {
      log(`could not record the submitted mutation: ${error.message}`); // never fails the call
    }
  }

  async function callTool(name, args, signal, params) {
    const local = await callLocal(name);
    if (local !== null) return local;
    try {
      const result = await remote.request('tools/call', params, { signal, timeoutMs: CALL_TIMEOUT_MS });
      if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new RemoteError('The WisePPC server sent a malformed tool result.', { kind: 'protocol' });
      if (name === 'submit_mutation') await recordMutations(result);
      return result;
    } catch (error) {
      if (error instanceof RemoteError && error.kind === 'aborted') throw error; // cancelled: the stdio layer sends nothing
      if (signal?.aborted) throw error;
      return text(describeRemoteFailure(error), true);
    }
  }

  // --- sign-in changes ---------------------------------------------------------------------------

  let signature; // what the sign-in looked like when we last looked
  const currentSignature = async () => {
    const state = await readState(env);
    return `${isSignedIn(state)}:${state.login_generation}`; // a token refresh changes neither part
  };

  /** Compare with the last look; on a change drop the session and announce the new tool list. */
  async function checkSignIn() {
    try {
      const now = await currentSignature();
      if (signature === undefined) {
        signature = now;
        return false;
      }
      if (now === signature) return false;
      signature = now;
      remote.resetSession();
      toolsChanged();
      return true;
    } catch (error) {
      log(`could not read the sign-in state: ${error.message}`);
      return false;
    }
  }

  let watcher;
  let timer;
  let debounce;
  /** Watch the profile directory (oauth.json is replaced by rename, so the file itself cannot be watched). */
  async function startWatching() {
    await checkSignIn(); // sets the baseline
    try {
      watcher = watch(await ensureProfileDir(env), { persistent: false }, (_event, file) => {
        if (file && String(file) !== STATE_FILE) return; // not oauth.json.<pid>.<rand>.tmp: reading mid-write races the rename
        clearTimeout(debounce);
        debounce = setTimeout(checkSignIn, 50);
        debounce.unref();
      });
      watcher.on('error', () => {}); // the poll below still covers us
    } catch (error) {
      log(`not watching the sign-in file (${error.message}); polling instead`);
    }
    timer = setInterval(checkSignIn, pollMs);
    timer.unref();
  }

  function stopWatching() {
    watcher?.close();
    clearInterval(timer);
    clearTimeout(debounce);
  }

  return { listTools, callTool, checkSignIn, startWatching, stopWatching, mutations, remote, cachedInstructions, rememberInstructions };
}
