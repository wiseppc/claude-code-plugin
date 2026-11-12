// A Streamable HTTP MCP client for the WisePPC remote server, on Node built-ins only.
//
//   const remote = createRemote({ url, getAccessToken, onNotification });
//   const result = await remote.request('tools/call', params, { signal });
//
// How it talks to the server:
// - Every message is a POST with `Accept: application/json, text/event-stream` and a Bearer token.
//   The answer is either one JSON body or an SSE stream. The stream is read only up to the response
//   whose id matches our request; notifications seen on the way (progress, list_changed, ...) are
//   handed to onNotification. The server speaks the legacy carrier (a session id, no modern
//   handshake), so we ask for protocol 2025-11-25 and use whatever supported version it answers with.
// - The session is created lazily by the first request. Afterwards every POST carries
//   `Mcp-Session-Id` and `MCP-Protocol-Version`.
// - 401: the token is force-refreshed once (getAccessToken does that under the shared lock) and the
//   request is retried once. 404 with a session: the session expired, so we initialize again and
//   retry once. 429 becomes a RemoteError carrying Retry-After.
// - Limits: 8 MiB per response, no redirects, a User-Agent, and a timeout on every request.
// - Aborting the caller's signal cancels the fetch and sends notifications/cancelled upstream.
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from './stdio.mjs';

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SETUP_TIMEOUT_MS = 15_000; // initialize, tools/list, notifications
export const CALL_TIMEOUT_MS = 180_000; // tools/call may run a slow analytics query
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * kind: unauthorized | forbidden | rate_limited | http | rpc | network | timeout | aborted | protocol
 * rpc errors carry the server's JSON-RPC `code` and `data`; rate_limited carries `retryAfter`
 * (the header text, in seconds or an HTTP date).
 */
export class RemoteError extends Error {
  constructor(message, { kind, status, retryAfter, code, data } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.data = data;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Split an SSE byte stream into the JSON payloads of its `data:` fields, one per event. */
async function* sseMessages(chunks, log) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return undefined; // a comment, a priming event or a keep-alive
    try {
      return JSON.parse(data);
    } catch {
      log('ignoring an SSE event that is not JSON');
      return undefined;
    }
  };
  for await (const chunk of chunks) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n?/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const message = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (message !== undefined) yield message;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last !== undefined) yield last;
}

/** The body's chunks, failing once more than maxBytes have arrived in total. */
async function* cappedChunks(response, maxBytes) {
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new RemoteError('The WisePPC server sent a response larger than 8 MiB.', { kind: 'protocol' });
    yield chunk;
  }
}

async function readText(response, maxBytes) {
  const parts = [];
  for await (const chunk of cappedChunks(response, maxBytes)) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * @param {object} options
 * @param {string} options.url                       the MCP endpoint
 * @param {(opts?: {force401Token?: string}) => Promise<{token: string}>} options.getAccessToken
 * @param {string} options.userAgent                 "wiseppc-live/<version> claude-code"
 * @param {string} [options.clientVersion]           reported in clientInfo
 * @param {(method: string, params?: object) => void} [options.onNotification]  server notifications
 * @param {(instructions: string) => void} [options.onInstructions]  the server's initialize `instructions`, each time a session starts
 * @param {(line: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.maxResponseBytes]
 */
export function createRemote(options) {
  const {
    url,
    getAccessToken,
    userAgent,
    clientVersion = '0',
    onNotification = () => {},
    onInstructions = () => {},
    log = () => {},
    fetchImpl = fetch,
    maxResponseBytes = MAX_RESPONSE_BYTES,
  } = options;

  let session = null; // { id, version } once initialized; id is null for a stateless server
  let starting = null; // the in-flight initialize, shared by concurrent first requests
  let nextId = 0;

  // --- one HTTP exchange -----------------------------------------------------------------------

  /** POST a JSON-RPC message. Resolves { response, signal } for any HTTP status; throws on transport failure. */
  async function postOnce(body, { token, sessionState, signal, timeoutMs }) {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': userAgent,
    };
    if (sessionState) {
      headers['mcp-protocol-version'] = sessionState.version;
      if (sessionState.id) headers['mcp-session-id'] = sessionState.id;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: combined });
      return { response, signal: combined, timeout };
    } catch (error) {
      throw transportError(error, signal, timeout);
    }
  }

  function transportError(error, callerSignal, timeout) {
    if (error instanceof RemoteError) return error;
    if (callerSignal?.aborted) return new RemoteError('The request was cancelled.', { kind: 'aborted' });
    if (timeout.aborted) return new RemoteError('The WisePPC server did not answer in time.', { kind: 'timeout' });
    const label = error?.cause?.code ?? error?.code ?? error?.name ?? 'error';
    return new RemoteError(`Could not reach the WisePPC server (${label}).`, { kind: 'network' });
  }

  /** Turn a non-2xx response into the most useful error: the server's own JSON-RPC error when it sent one. */
  async function failureFor(response) {
    const status = response.status;
    if (status === 401) return new RemoteError('WisePPC rejected the sign-in.', { kind: 'unauthorized', status });
    if (status === 429) {
      const retryAfter = response.headers.get('retry-after') ?? undefined;
      const wait = retryAfter ? `Retry after ${retryAfter}${/^\d+$/.test(retryAfter) ? ' seconds' : ''}.` : 'No Retry-After was given; wait a moment before retrying.';
      return new RemoteError(`WisePPC is rate limiting requests. ${wait}`, { kind: 'rate_limited', status, retryAfter });
    }
    let parsed;
    try {
      parsed = JSON.parse(await readText(response, MAX_ERROR_BODY_BYTES));
    } catch {
      parsed = undefined;
    }
    if (isObject(parsed?.error) && typeof parsed.error.message === 'string') {
      return new RemoteError(parsed.error.message, { kind: 'rpc', status, code: parsed.error.code, data: parsed.error.data });
    }
    return new RemoteError(`The WisePPC server answered HTTP ${status}.`, { kind: status === 403 ? 'forbidden' : 'http', status });
  }

  /**
   * Read the answer to message `expectId`, forwarding notifications on the way. Resolves the JSON-RPC
   * result; throws RemoteError for a JSON-RPC error. With expectId undefined the body is not needed.
   */
  async function readAnswer(response, expectId, post) {
    if (expectId === undefined) return undefined; // a notification or a reply: no answer to wait for
    const type = response.headers.get('content-type') ?? '';
    let messages;
    if (type.includes('text/event-stream')) {
      messages = sseMessages(cappedChunks(response, maxResponseBytes), log);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(await readText(response, maxResponseBytes));
      } catch (error) {
        if (error instanceof RemoteError) throw error;
        throw new RemoteError('The WisePPC server sent a response that is not valid JSON.', { kind: 'protocol' });
      }
      messages = Array.isArray(parsed) ? parsed : [parsed];
    }
    for await (const message of messages) {
      if (!isObject(message)) continue;
      if (typeof message.method === 'string') {
        if (message.id === undefined) onNotification(message.method, message.params);
        else answerServerRequest(message, post);
        continue;
      }
      if (message.id !== expectId) continue; // a response to something else: not ours
      if (isObject(message.error)) {
        throw new RemoteError(String(message.error.message ?? 'The WisePPC server returned an error.'), { kind: 'rpc', code: message.error.code, data: message.error.data });
      }
      return message.result; // leaving the loop closes the stream; the rest of it is not needed
    }
    throw new RemoteError('The WisePPC server ended its response without answering.', { kind: 'protocol' });
  }

  /** We advertise no client capabilities, so a server-to-client request gets a refusal (ping gets its empty answer). */
  function answerServerRequest(message, post) {
    const reply = message.method === 'ping'
      ? { jsonrpc: '2.0', id: message.id, result: {} }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    post(reply).catch(() => {});
  }

  /**
   * Send one message with the 401 and session-expiry recovery. Resolves the result for `expectId`.
   * `useSession` is false only for initialize.
   */
  async function exchange(body, { expectId, signal, timeoutMs, useSession = true, onHeaders }) {
    let refreshedToken = false;
    let reinitialized = false;
    let token = (await getAccessToken()).token;
    for (;;) {
      const sessionState = useSession ? session : null;
      const { response, signal: combined, timeout } = await postOnce(body, { token, sessionState, signal, timeoutMs });
      let recovery; // set when this response is a 401 or an expired session that we can recover from
      try {
        if (response.status === 401 && !refreshedToken) recovery = 'refresh';
        // `!starting`: a 404 while initializing is a real failure, and re-initializing would wait on itself.
        else if (response.status === 404 && useSession && sessionState?.id && !reinitialized && !starting) recovery = 'reinitialize';
        else {
          if (!response.ok) throw await failureFor(response);
          onHeaders?.(response.headers);
          return await readAnswer(response, expectId, reply => post(reply, { signal }));
        }
      } catch (error) {
        throw transportError(error, signal, timeout);
      } finally {
        if (!combined.aborted) await response.body?.cancel().catch(() => {});
      }
      // Recovery runs outside the try above so that a SignedOutError or OAuthError from the refresh
      // reaches the caller as itself, not as a network failure.
      if (recovery === 'refresh') {
        refreshedToken = true;
        token = (await getAccessToken({ force401Token: token })).token; // refreshes under the shared lock
      } else {
        reinitialized = true;
        if (session === sessionState) session = null; // another request may have renewed it already
        await ensureSession();
      }
    }
  }

  /** A fire-and-forget style POST that expects no answer body (notifications and replies). */
  function post(message, { signal, timeoutMs = SETUP_TIMEOUT_MS } = {}) {
    return exchange(message, { expectId: undefined, signal, timeoutMs });
  }

  // --- the session and the public request ------------------------------------------------------

  function ensureSession() {
    if (session) return Promise.resolve(session);
    starting ??= startSession().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function startSession() {
    const id = ++nextId;
    let headers;
    const result = await exchange({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'wiseppc-live', version: clientVersion } },
    }, { expectId: id, timeoutMs: SETUP_TIMEOUT_MS, useSession: false, onHeaders: received => (headers = received) });
    const version = result?.protocolVersion;
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new RemoteError(`The WisePPC server answered with a protocol version this plugin does not support (${version}).`, { kind: 'protocol' });
    }
    session = { id: headers.get('mcp-session-id') || null, version }; // a stateless server sends no session id
    if (typeof result?.instructions === 'string' && result.instructions) {
      try {
        onInstructions(result.instructions);
      } catch (error) {
        log(`could not keep the server instructions: ${error.message}`);
      }
    }
    try {
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (error) {
      session = null;
      throw error;
    }
    return session;
  }

  /**
   * Send a request and resolve its result (verbatim, as the server sent it). Throws RemoteError.
   * @param {string} method
   * @param {object} [params]
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   */
  async function request(method, params, { signal, timeoutMs = SETUP_TIMEOUT_MS } = {}) {
    if (signal?.aborted) throw new RemoteError('The request was cancelled.', { kind: 'aborted' });
    await ensureSession();
    const id = ++nextId;
    const cancelUpstream = () => {
      post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled by the client' } }).catch(() => {});
    };
    signal?.addEventListener('abort', cancelUpstream, { once: true });
    try {
      const body = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
      return await exchange(body, { expectId: id, signal, timeoutMs });
    } finally {
      signal?.removeEventListener('abort', cancelUpstream);
    }
  }

  return {
    request,
    /** Forget the session (after sign-in changes); the next request initializes a new one. */
    resetSession: () => {
      session = null;
    },
    get hasSession() {
      return session !== null;
    },
  };
}
