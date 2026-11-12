// OAuth for wiseppc-live: discovery, one-time client registration, browser login (PKCE), token
// refresh under a cross-process lock, and logout. Node built-ins only.
//
// Server contract (wiseppc-mcp, business-scoped OAuth):
// - Metadata: /.well-known/oauth-protected-resource and /.well-known/oauth-authorization-server on
//   the server origin. The issuer and the protected resource are both that origin, which is also the
//   `resource` value sent on authorize, code exchange and refresh. It is NOT a fixed string: the
//   server compares it to its own MCP_PUBLIC_URL, so we take it from the configured URL's origin.
// - Registration (JSON only): a public client, redirect http://127.0.0.1/callback. At authorize time
//   the loopback port may differ from the registered one; host, path and query must match, and the
//   token request must repeat the exact redirect_uri used at authorize.
// - The callback carries `state` and `iss` (and `error=access_denied` if the user declines).
// - Refresh tokens are single use and rotate. Reusing one revokes the whole connection, so a refresh
//   is only ever sent while holding oauth.lock, after re-reading the file (see refreshLocked).
// - 400 invalid_grant is the only answer that ends the sign-in. 429, 5xx and network errors never do.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { openBrowser } from './browser.mjs';
import { emptyState, isSignedIn, mcpUrl, profileName, readState, updateState, withLock, writeState } from './store.mjs';

export const CLIENT_NAME = 'Claude Code (WisePPC Live)';
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';
const REFRESH_MARGIN_MS = 120_000; // refresh when fewer than 120 s remain
const REFRESH_TIMEOUT_MS = 12_000; // keeps a refresh well inside the 60 s lock staleness
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const LOGIN_TIMEOUT_MS = 10 * 60_000; // the server keeps an authorization request for at least 5 min

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (min, spread) => min + Math.random() * spread;

let cachedUserAgent;
function userAgent() {
  if (!cachedUserAgent) {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    cachedUserAgent = `wiseppc-live/${manifest.version} claude-code`;
  }
  return cachedUserAgent;
}

// --- errors ------------------------------------------------------------------------------------

const SIGNED_OUT_MESSAGES = {
  not_signed_in: 'Not signed in to WisePPC. Run wiseppc_live_login to sign in.',
  invalid_grant: 'The WisePPC connection has ended (it expired, was revoked, or was replaced). Run wiseppc_live_login to sign in again.',
  invalid_client: 'WisePPC no longer recognizes this client registration. Run wiseppc_live_login to register and sign in again.',
  invalid_response: 'WisePPC answered the sign-in refresh unexpectedly, so the stored sign-in was discarded. Run wiseppc_live_login to sign in again.',
};

/** The profile has no usable sign-in. Callers show the message; it never contains credentials. */
export class SignedOutError extends Error {
  constructor(reason = 'not_signed_in') {
    super(SIGNED_OUT_MESSAGES[reason] ?? SIGNED_OUT_MESSAGES.not_signed_in);
    this.reason = reason;
  }
}

/** kind: invalid_grant | invalid_client | rate_limited | unavailable | network | protocol */
export class OAuthError extends Error {
  constructor(message, { kind, status, retryAfter } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// --- configuration and HTTP --------------------------------------------------------------------

/** { origin, url } for the configured server. origin doubles as issuer and as the OAuth `resource`. */
export function serverConfig(env = process.env) {
  const url = mcpUrl(env);
  return { url, origin: url.origin };
}

function networkError(error) {
  const label = error?.cause?.code ?? error?.code ?? error?.name ?? 'error';
  return new OAuthError(`Could not complete a request to the WisePPC server (${label}).`, { kind: 'network' });
}

async function readBodyCapped(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new OAuthError('The WisePPC server sent an oversized response.', { kind: 'protocol' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One HTTP request. Resolves with { status, headers, json } for any HTTP status; throws only on transport failure. */
async function http(url, { method = 'GET', form, json, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { 'user-agent': userAgent(), accept: 'application/json' };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let response;
  let text;
  try {
    response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    text = await readBodyCapped(response);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw networkError(error);
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, json: parsed };
}

function classifyFailure(result, what) {
  const code = typeof result.json?.error === 'string' ? result.json.error : undefined;
  const retryAfter = Number(result.headers.get('retry-after'));
  const base = { status: result.status, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined };
  if (result.status === 429) return new OAuthError(`${what} was rate limited by WisePPC. Try again in a minute.`, { ...base, kind: 'rate_limited' });
  if (result.status >= 500) return new OAuthError(`${what} failed: WisePPC is temporarily unavailable.`, { ...base, kind: 'unavailable' });
  if (code === 'invalid_grant') return new OAuthError(`${what} was refused (invalid_grant).`, { ...base, kind: 'invalid_grant' });
  if (code === 'invalid_client') return new OAuthError(`${what} was refused (invalid_client).`, { ...base, kind: 'invalid_client' });
  const known = ['access_denied', 'invalid_request', 'invalid_scope', 'invalid_target', 'unsupported_grant_type', 'invalid_redirect_uri', 'invalid_client_metadata'];
  return new OAuthError(`${what} was refused (${known.includes(code) ? code : `HTTP ${result.status}`}).`, { ...base, kind: 'protocol' });
}

// --- discovery ---------------------------------------------------------------------------------

const discoveryCache = new Map(); // origin -> { at, meta }
const DISCOVERY_TTL_MS = 60 * 60_000;

function checkEndpoint(value, origin, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`WisePPC metadata has an invalid ${name}.`, { kind: 'protocol' });
  }
  if (url.origin !== origin) throw new OAuthError(`WisePPC metadata ${name} is on a different origin; refusing it.`, { kind: 'protocol' });
  return url.href;
}

/** Fetch and validate both metadata documents. Everything must be on the configured origin. */
export async function discover(config = serverConfig()) {
  const { origin } = config;
  const cached = discoveryCache.get(origin);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.meta;

  const fetchMetadata = async path => {
    const result = await http(`${origin}${path}`);
    if (result.status !== 200 || result.json === null || typeof result.json !== 'object') {
      throw new OAuthError(`Could not read WisePPC OAuth metadata (${path}, HTTP ${result.status}).`, { kind: 'protocol' });
    }
    return result.json;
  };
  const strip = value => (typeof value === 'string' ? value.replace(/\/+$/, '') : value);

  const resource = await fetchMetadata('/.well-known/oauth-protected-resource');
  if (strip(resource.resource) !== origin) throw new OAuthError('The protected resource in WisePPC metadata does not match the server; refusing to sign in.', { kind: 'protocol' });
  if (!Array.isArray(resource.authorization_servers) || !resource.authorization_servers.map(strip).includes(origin)) {
    throw new OAuthError('WisePPC metadata names a different authorization server; refusing to sign in.', { kind: 'protocol' });
  }

  const server = await fetchMetadata('/.well-known/oauth-authorization-server');
  if (strip(server.issuer) !== origin) throw new OAuthError('The authorization server issuer does not match the server; refusing to sign in.', { kind: 'protocol' });
  if (!Array.isArray(server.code_challenge_methods_supported) || !server.code_challenge_methods_supported.includes('S256')) {
    throw new OAuthError('The authorization server does not support S256 PKCE.', { kind: 'protocol' });
  }
  const meta = {
    issuer: origin,
    resource: origin,
    authorization_endpoint: checkEndpoint(server.authorization_endpoint, origin, 'authorization_endpoint'),
    token_endpoint: checkEndpoint(server.token_endpoint, origin, 'token_endpoint'),
    registration_endpoint: checkEndpoint(server.registration_endpoint, origin, 'registration_endpoint'),
    revocation_endpoint: server.revocation_endpoint ? checkEndpoint(server.revocation_endpoint, origin, 'revocation_endpoint') : undefined,
  };
  discoveryCache.set(origin, { at: Date.now(), meta });
  return meta;
}

/** Forget cached discovery (tests, and after a failed sign-in). */
export function resetDiscoveryCache() {
  discoveryCache.clear();
}

// --- client registration -----------------------------------------------------------------------

/** Register once per profile (and again only if the server or its registration changed). */
async function ensureClient(meta) {
  const state = await readState();
  if (state.client_id && state.issuer === meta.issuer) return state.client_id;
  const result = await http(meta.registration_endpoint, {
    method: 'POST',
    json: {
      client_name: CLIENT_NAME,
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    },
  });
  if (result.status !== 201 && result.status !== 200) throw classifyFailure(result, 'Client registration');
  const clientId = result.json?.client_id;
  if (typeof clientId !== 'string' || !clientId) throw new OAuthError('WisePPC did not return a client id.', { kind: 'protocol' });
  await updateState(current => {
    // A different issuer means any stored tokens belong to another server; they cannot be used.
    const base = current.issuer === meta.issuer ? current : { ...emptyState(), login_generation: current.login_generation, generation: current.generation };
    return { ...base, issuer: meta.issuer, client_id: clientId };
  });
  return clientId;
}

// --- token endpoint ----------------------------------------------------------------------------

function parseTokens(json, { requireRefresh }) {
  const ok =
    json && typeof json.access_token === 'string' && json.access_token &&
    String(json.token_type).toLowerCase() === 'bearer' &&
    Number.isFinite(json.expires_in) && json.expires_in > 0 &&
    (!requireRefresh || (typeof json.refresh_token === 'string' && json.refresh_token));
  if (!ok) throw new OAuthError('WisePPC returned an unexpected token response.', { kind: 'protocol' });
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + json.expires_in * 1000 };
}

async function tokenRequest(meta, form, { what, timeoutMs }) {
  const result = await http(meta.token_endpoint, { method: 'POST', form, timeoutMs });
  if (result.status !== 200) throw classifyFailure(result, what);
  return result.json;
}

// --- login -------------------------------------------------------------------------------------

let pendingLogin = null; // { url, expiresAt, cancel }

export function loginPending() {
  return pendingLogin ? { url: pendingLogin.url, expiresAt: pendingLogin.expiresAt } : null;
}

const base64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = text => createHash('sha256').update(text).digest();

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32em;margin:4em auto"><h1>${title}</h1><p>${text}</p></body>`;

/**
 * Begin a browser login. Resolves as soon as the authorization URL exists; the code exchange
 * finishes in the background. `done` always resolves, with { ok: true } or { ok: false, message }.
 *
 * options.openBrowser  open the system browser (default true)
 * options.onComplete   called once with { ok, message } when the login ends
 * options.timeoutMs    how long to wait for the browser callback
 * options.keepAlive    keep the process alive while waiting (CLI mode)
 */
export async function startLogin(options = {}) {
  if (pendingLogin) return { url: pendingLogin.url, done: pendingLogin.done, reused: true };
  const { openBrowser: shouldOpen = true, onComplete, timeoutMs = LOGIN_TIMEOUT_MS, keepAlive = false } = options;
  const config = serverConfig();
  const meta = await discover(config);
  const clientId = await ensureClient(meta);

  const verifier = base64url(randomBytes(48)); // 64 characters, within the 43-128 PKCE range
  const challenge = base64url(sha256(verifier));
  const state = base64url(randomBytes(32));

  let finish;
  const done = new Promise(resolve => (finish = resolve));
  let settled = false;
  let timer;
  const listener = createServer();
  const settle = result => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pendingLogin = null;
    listener.close();
    setTimeout(() => listener.closeAllConnections?.(), 1000).unref(); // let the final page reach the browser first
    finish(result);
    onComplete?.(result);
  };
  const fail = message => settle({ ok: false, message });

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  listener.on('error', () => fail('The local sign-in listener failed.'));
  const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;

  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    resource: meta.resource,
    state,
  }).toString();

  const handleRequest = async (req, res, reply) => {
    // Only origin-form targets: `//` and friends would parse as a protocol-relative URL (or throw).
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return reply(400, 'Bad request', 'Not a valid request.');
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return reply(400, 'Bad request', 'Not a valid request.');
    }
    if (settled || req.method !== 'GET' || url.pathname !== '/callback') return reply(404, 'Not found', 'Nothing here.');
    const params = url.searchParams;
    // A request with the wrong state is not ours (or an attack): ignore it and keep waiting.
    if (!safeEqual(params.get('state'), state)) return reply(400, 'Unexpected request', 'This sign-in link is not valid. Return to Claude Code and try again.');
    // The server sends its public URL as `iss`, which may carry a trailing slash the origin does not.
    if (!safeEqual((params.get('iss') ?? '').replace(/\/+$/, ''), meta.issuer)) {
      reply(400, 'Sign-in rejected', 'The sign-in response came from an unexpected server.');
      return fail('Sign-in was rejected: the response did not come from the WisePPC server.');
    }
    if (params.has('error')) {
      reply(200, 'Sign-in cancelled', 'WisePPC was not connected. You can close this tab.');
      return fail(params.get('error') === 'access_denied' ? 'Sign-in was declined in the browser.' : 'Sign-in was not completed.');
    }
    const code = params.get('code');
    if (!code || code.length > 512) {
      reply(400, 'Sign-in failed', 'The response had no authorization code.');
      return fail('Sign-in failed: no authorization code was returned.');
    }
    try {
      const json = await tokenRequest(
        meta,
        { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource: meta.resource },
        { what: 'Sign-in', timeoutMs: REQUEST_TIMEOUT_MS },
      );
      const tokens = parseTokens(json, { requireRefresh: true });
      await updateState(current => ({
        ...current,
        ...tokens,
        issuer: meta.issuer,
        client_id: clientId,
        generation: (current.generation ?? 0) + 1,
        login_generation: (current.login_generation ?? 0) + 1,
        connected_at: Date.now(),
        signed_out_reason: undefined,
        signed_out_at: undefined,
      }));
      reply(200, 'WisePPC connected', 'You are signed in. You can close this tab and return to Claude Code.');
      settle({ ok: true, message: 'Signed in to WisePPC.' });
    } catch (error) {
      reply(500, 'Sign-in failed', 'Return to Claude Code for details.');
      fail(error instanceof OAuthError ? error.message : 'Sign-in failed unexpectedly.');
    }
  };

  // Nothing a request does may escape this handler (it would kill the server) or end the pending login.
  listener.on('request', async (req, res) => {
    const reply = (status, title, text) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(PAGE(title, text));
    };
    try {
      await handleRequest(req, res, reply);
    } catch {
      try {
        if (res.headersSent) res.destroy();
        else reply(500, 'Something went wrong', 'Return to Claude Code and try again.');
      } catch {
        res.destroy();
      }
    }
  });

  timer = setTimeout(() => fail('Sign-in timed out. Run wiseppc_live_login to try again.'), timeoutMs);
  if (!keepAlive) {
    timer.unref();
    listener.unref();
  }
  pendingLogin = { url: authorize.href, expiresAt: Date.now() + timeoutMs, done, cancel: () => fail('Sign-in was cancelled.') };
  if (shouldOpen) openBrowser(authorize.href); // best effort; the URL is returned to the caller either way
  return { url: authorize.href, done, reused: false };
}

// --- refresh -----------------------------------------------------------------------------------

/**
 * The current access token, refreshed first when fewer than 120 s remain.
 *
 * force401Token: pass the token that just got a 401. If another process has already replaced it,
 * that newer token is returned without any network call; otherwise the token is refreshed even if
 * the clock says it is still valid.
 *
 * Resolves { token, expiresAt, generation }. Throws SignedOutError when there is no sign-in (or it
 * just ended), and OAuthError for transient failures (the stored sign-in is kept in that case).
 */
export async function getAccessToken({ force401Token } = {}) {
  const state = await currentState();
  if (!isSignedIn(state)) throw new SignedOutError(state.signed_out_reason ?? 'not_signed_in');
  const stale = force401Token ? state.access_token === force401Token : state.expires_at - Date.now() < REFRESH_MARGIN_MS;
  if (!stale) return view(state);
  try {
    return await refreshOnce(force401Token);
  } catch (error) {
    // A transient failure must not break a token that still works.
    if (!force401Token && error instanceof OAuthError && state.expires_at > Date.now()) return view(state);
    throw error;
  }
}

// A refresh whose result could not be written to disk (Windows kept oauth.json busy for the whole
// retry window). The old refresh token on disk is already spent, so this process keeps using the new
// tokens from memory, tries to persist them again on later calls, and reports the error in status.
// It is dropped as soon as the file on disk is as new as it (a login, logout or write elsewhere wins).
let unsaved = null; // { state, error }
let lastPersistTry = 0;
const PERSIST_RETRY_MS = 5000;

/** oauth.json, unless this process holds a newer refresh that has not reached the disk yet. */
async function currentState() {
  const disk = await readState();
  if (!unsaved) return disk;
  if (unsaved.state.generation <= disk.generation) {
    unsaved = null;
    return disk;
  }
  if (Date.now() - lastPersistTry > PERSIST_RETRY_MS) await persistUnsaved();
  return unsaved ? unsaved.state : readState();
}

/** Try once more, under the lock, to make the held-back tokens durable. Never throws. */
async function persistUnsaved() {
  lastPersistTry = Date.now();
  try {
    await withLock(async () => {
      const held = unsaved;
      if (!held) return;
      if ((await readState()).generation >= held.state.generation) {
        unsaved = null;
        return;
      }
      await writeState(held.state);
      unsaved = null;
    }, { waitMs: 2000 });
  } catch (error) {
    if (unsaved) unsaved.error = error;
  }
}

/** Inside the lock: the held-back refresh replaces the disk state when it is newer. */
function unsavedOver(disk) {
  if (unsaved && unsaved.state.generation > disk.generation) return unsaved.state;
  unsaved = null;
  return disk;
}

const view = state => ({ token: state.access_token, expiresAt: state.expires_at, generation: state.generation });

const inflight = new Map(); // one refresh per process at a time
function refreshOnce(force401Token) {
  const key = force401Token ?? '';
  if (!inflight.has(key)) inflight.set(key, refreshLocked(force401Token).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

/** Steps 2-7 of the plan: take the lock, re-read, adopt a peer's refresh or send exactly one. */
async function refreshLocked(force401Token) {
  const config = serverConfig();
  const meta = await discover(config); // network, so before the lock is taken
  return withLock(async lock => {
    const state = unsavedOver(await readState());
    if (!isSignedIn(state)) throw new SignedOutError(state.signed_out_reason ?? 'not_signed_in');
    // Step 3: someone else may have refreshed while we waited. Never send a refresh token twice.
    const stillStale = force401Token ? state.access_token === force401Token : state.expires_at - Date.now() < REFRESH_MARGIN_MS;
    if (!stillStale) return view(state);

    if (state.issuer !== meta.issuer || !state.client_id) throw new SignedOutError('invalid_client');
    const form = { grant_type: 'refresh_token', refresh_token: state.refresh_token, client_id: state.client_id, resource: meta.resource };

    let json;
    for (let attempt = 0; ; attempt++) {
      if (!(await lock.stillHeld())) throw new OAuthError('Lost the sign-in refresh lock; try again.', { kind: 'unavailable' });
      try {
        json = await tokenRequest(meta, form, { what: 'Refreshing the sign-in', timeoutMs: REFRESH_TIMEOUT_MS });
        break;
      } catch (error) {
        if (error instanceof OAuthError && error.kind === 'invalid_grant') return signOutLocked(state, 'invalid_grant');
        if (error instanceof OAuthError && error.kind === 'invalid_client') return signOutLocked(state, 'invalid_client', { forgetClient: true });
        // Step 7: a network failure is retried once, whether the request was sent or not. If the
        // server did process it, the retry is refused with invalid_grant and the user signs in again,
        // which is the same outcome as losing the response.
        if (error instanceof OAuthError && error.kind === 'network' && attempt === 0) {
          await sleep(jitter(250, 500));
          continue;
        }
        throw error;
      }
    }
    let tokens;
    try {
      tokens = parseTokens(json, { requireRefresh: true });
    } catch {
      return signOutLocked(state, 'invalid_response'); // the old refresh token is spent; nothing to keep
    }
    // Step 5: write (temp, fsync, rename) before the lock is released, and bump the generation.
    const next = { ...state, ...tokens, generation: state.generation + 1 };
    try {
      await writeState(next);
      unsaved = null;
    } catch (error) {
      // The rotated refresh token exists only in memory now. Keep it (never fall back to the spent
      // one on disk) and surface the failure through status instead of failing the request.
      unsaved = { state: next, error };
      lastPersistTry = Date.now();
    }
    return view(next);
  });
}

async function signOutLocked(state, reason, { forgetClient = false } = {}) {
  const next = { ...state, generation: state.generation + 1, signed_out_reason: reason, signed_out_at: Date.now() };
  for (const key of ['access_token', 'refresh_token', 'expires_at', 'connected_at']) delete next[key];
  if (forgetClient) delete next.client_id;
  await writeState(next);
  throw new SignedOutError(reason);
}

// --- logout and status -------------------------------------------------------------------------

/** Revoke the connection at the server (best effort) and delete the stored tokens. */
export async function logout() {
  pendingLogin?.cancel();
  return withLock(async () => {
    const state = await readState();
    let revoked = false;
    if (state.refresh_token && state.client_id) {
      try {
        const meta = await discover();
        if (meta.revocation_endpoint) {
          // Revoking the refresh token ends the whole connection, the access token included.
          const result = await http(meta.revocation_endpoint, { method: 'POST', form: { token: state.refresh_token, client_id: state.client_id }, timeoutMs: 10_000 });
          revoked = result.status === 200;
        }
      } catch {
        // Offline or the server is down: still sign out locally.
      }
    }
    const next = { ...state, generation: state.generation + 1 };
    for (const key of ['access_token', 'refresh_token', 'expires_at', 'connected_at', 'signed_out_reason', 'signed_out_at']) delete next[key];
    await writeState(next);
    return { wasSignedIn: isSignedIn(state), revoked };
  });
}

/** Redacted description of the local sign-in. Never includes tokens, codes or verifiers. */
export async function status() {
  const state = await currentState();
  const signedIn = isSignedIn(state);
  const secondsLeft = signedIn ? Math.round((state.expires_at - Date.now()) / 1000) : undefined;
  return {
    profile: profileName(),
    server: serverConfig().origin,
    signedIn,
    clientRegistered: Boolean(state.client_id),
    accessTokenSecondsLeft: signedIn ? Math.max(0, secondsLeft) : undefined,
    generation: state.generation,
    loginGeneration: state.login_generation,
    loginPending: Boolean(pendingLogin),
    signedOutReason: signedIn ? undefined : state.signed_out_reason,
    storeWriteError: unsaved ? `The refreshed sign-in could not be saved to disk (${unsaved.error?.code ?? unsaved.error?.message}); it is kept in memory for this process.` : undefined,
  };
}
