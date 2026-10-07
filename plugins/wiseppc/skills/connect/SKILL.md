---
name: connect
description: Connect to WisePPC MCP and diagnose authorized access or duplicate connections.
---

Inspect `/mcp` for existing WisePPC connections before enabling another. Never silently rewrite Claude settings. Use the trusted HTTPS /mcp endpoint supplied by WisePPC and an existing key entered through the plugin's sensitive configuration field. Never ask for keys in chat, inspect secure storage, print environment secrets, or mint tokens.

Discover current server tools and instructions. Where the server offers `get_connection_status`, call it first and follow its setup links. Once access is granted and a `profileId` is chosen, call `get_session_context` once for preferences, account guidance and `key_grants`; do not repeat it mid-session. Verify the connection with an authorized read or capabilities request; distinguish connectivity, authentication, account scope and per-operation denial. Do not test a write to check connectivity. If tools are unavailable, report the MCP status and guide the user to secure configuration. Fixing a permission denial belongs to the key owner/admin.
