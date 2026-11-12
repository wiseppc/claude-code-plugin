// Newline-delimited JSON-RPC 2.0 over stdio for an MCP server, on Node built-ins only.
//
// Protocol rules this module enforces (they decide whether Claude Code registers the channel):
// - initialize echoes the client's protocolVersion when it is one we support, otherwise answers
//   LATEST. Capabilities are fixed: tools (listChanged) plus the claude/channel experimental flag.
// - Nothing is written before notifications/initialized. Server-initiated messages sent earlier are
//   held back and flushed in order once the client confirms initialization.
// - server/discover and every other unknown request is answered immediately with -32601, in any
//   state, so a client probing for the modern protocol falls back to the legacy handshake at once.
// - stdout carries protocol messages only. Diagnostics go to stderr.

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const CAPABILITIES = Object.freeze({
  tools: { listChanged: true },
  experimental: { 'claude/channel': {} },
});

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasId = message => typeof message.id === 'string' || typeof message.id === 'number';

export function negotiateVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/**
 * @param {object} options
 * @param {{name: string, version: string}} options.serverInfo
 * @param {string} [options.instructions]
 * @param {(params: object) => object[] | {tools: object[], nextCursor?: string} | Promise<...>} options.listTools
 *        current tool definitions; params is the request's params (it carries the paging cursor)
 * @param {(name: string, args: object, signal: AbortSignal, params: object) => Promise<object>} options.callTool
 *        returns a CallToolResult; return null for an unknown tool name; params is the whole
 *        tools/call params (arguments plus _meta, for progress tokens)
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {(line: string) => void} [options.log]    stderr logger
 * @param {() => void} [options.onInitialized]      runs once, right after notifications/initialized (start anything that talks to the client)
 * @param {() => void} [options.onClose]            runs once when the input ends (stop timers here)
 */
export function createStdioServer(options) {
  const {
    serverInfo,
    instructions,
    listTools,
    callTool,
    input = process.stdin,
    output = process.stdout,
    log = line => process.stderr.write(`${line}\n`),
    onInitialized: whenInitialized = () => {},
    onClose = () => {},
  } = options;

  let initialized = false;
  let closed = false;
  const held = []; // server-initiated messages waiting for notifications/initialized
  const inflight = new Map(); // request id -> AbortController

  const write = message => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  /** Send a server-initiated message (notification), or hold it until the client is initialized. */
  function send(message) {
    if (!initialized) held.push(message);
    else write(message);
  }
  const notify = (method, params) => send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });

  function onInitialized() {
    if (initialized) return;
    initialized = true;
    for (const message of held.splice(0)) write(message);
    try {
      whenInitialized();
    } catch (error) {
      log(`onInitialized failed: ${error?.message ?? error}`);
    }
  }

  async function onToolCall(message) {
    const params = message.params;
    if (!isObject(params) || typeof params.name !== 'string') return fail(message.id, INVALID_PARAMS, 'tools/call requires a tool name');
    const args = isObject(params.arguments) ? params.arguments : {};
    const controller = new AbortController();
    inflight.set(message.id, controller);
    try {
      const result = await callTool(params.name, args, controller.signal, params);
      if (controller.signal.aborted) return; // cancelled: the client no longer expects an answer
      if (result === null || result === undefined) return fail(message.id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
      respond(message.id, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      log(`tool ${params.name} failed: ${error?.message ?? error}`);
      respond(message.id, { content: [{ type: 'text', text: 'The tool failed unexpectedly.' }], isError: true });
    } finally {
      inflight.delete(message.id);
    }
  }

  async function onToolList(message) {
    try {
      const listed = await listTools(isObject(message.params) ? message.params : {});
      respond(message.id, Array.isArray(listed) ? { tools: listed } : listed);
    } catch (error) {
      log(`tools/list failed: ${error?.message ?? error}`);
      fail(message.id, INTERNAL_ERROR, 'Internal error');
    }
  }

  function onRequest(message) {
    switch (message.method) {
      case 'initialize': {
        const params = isObject(message.params) ? message.params : {};
        const result = {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: CAPABILITIES,
          serverInfo,
        };
        if (instructions) result.instructions = instructions;
        return respond(message.id, result);
      }
      case 'ping':
        return respond(message.id, {});
      case 'tools/list':
        return void onToolList(message);
      case 'tools/call':
        return void onToolCall(message);
      default:
        // Includes server/discover. Answer at once; never leave a probe waiting.
        return fail(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  }

  function onNotification(message) {
    switch (message.method) {
      case 'notifications/initialized':
        return onInitialized();
      case 'notifications/cancelled': {
        const id = isObject(message.params) ? message.params.requestId : undefined;
        inflight.get(id)?.abort();
        return;
      }
      default:
        return; // unknown notifications are ignored by definition
    }
  }

  function onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, PARSE_ERROR, 'Parse error');
    }
    if (!isObject(message)) return fail(null, INVALID_REQUEST, 'Batches and non-object messages are not supported');
    if (typeof message.method !== 'string') return; // a response to a server request: we send none
    try {
      if (hasId(message)) onRequest(message);
      else onNotification(message);
    } catch (error) {
      log(`handler error: ${error?.message ?? error}`);
      if (hasId(message)) fail(message.id, INTERNAL_ERROR, 'Internal error');
    }
  }

  // Line framing over UTF-8 chunks.
  let buffer = '';
  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
    if (buffer.length > MAX_LINE_BYTES) {
      log('input line exceeds the size limit; dropping it');
      buffer = '';
    }
  });
  input.on('end', () => {
    for (const controller of inflight.values()) controller.abort();
    closed = true;
    onClose();
  });

  return {
    notify,
    toolsChanged: () => notify('notifications/tools/list_changed'),
    get initialized() {
      return initialized;
    },
  };
}
