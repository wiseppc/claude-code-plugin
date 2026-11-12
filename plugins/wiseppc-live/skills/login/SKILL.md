---
name: login
description: Sign in to or out of WisePPC with the wiseppc-live plugin and check the connection. Use when the WisePPC tools are missing, a call says you are signed out, or the user asks to connect, disconnect or check the WisePPC connection.
---

wiseppc-live signs in to WisePPC itself; there is no key to paste.

- Sign in: call `wiseppc_live_login`. It returns a link and opens it in the browser. The user approves the connection there, and the WisePPC tools appear once sign-in completes.
- Check: call `wiseppc_live_status`. It shows whether you are signed in, the event channel state and the last event error code. It never shows credentials.
- Sign out: call `wiseppc_live_logout` only when the user asks. It revokes the connection at WisePPC and deletes the stored sign-in from this computer.
- From a terminal: `node "${CLAUDE_PLUGIN_ROOT}/server.mjs" login`, `logout` or `status`.

What the connection may read or change is decided in WisePPC, per connection. If a tool is refused, report the reason code and let the user decide whether to widen it.

Use wiseppc-live instead of the standard wiseppc plugin, not next to it; with both enabled every tool appears twice.
