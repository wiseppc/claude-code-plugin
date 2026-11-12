# Changelog

## 0.3.0 - 2026-11-12

Two plugins now ship in one marketplace: `wiseppc` (standard) and the opt-in `wiseppc-live`.

### wiseppc

- Sign in with your WisePPC account (OAuth) instead of an API key. Run `/mcp`, pick `wiseppc` and authenticate: the browser opens WisePPC, you sign in, choose the business and approve. The API key field is gone; if you used an earlier version, sign in once through `/mcp`.
- A new connection is read-only: Claude never changes your Amazon account by itself. It proposes changes through WisePPC for a person to approve there. Owners and admins decide in WisePPC which changes a connection may propose and whether any may run without approval; permission changes apply on the next call.
- Fuller skills for analytics, connecting and submitting changes, with clearer triggers for Amazon Ads, Seller Central, Brand Store and Attribution questions.
- Skills use WisePPC's current tool names.
- Directory listing details: display name, icon, documentation, support, privacy policy and terms links. Documentation points to wiseppc.com/docs/mcp and the homepage to wiseppc.com/mcp (both plugins).
- The WisePPC settings page for connections is now **AI Integration → Connections & Permissions** (it was AI Connections & MCP Keys).
- The experimental event bridge from earlier previews is removed from this plugin. Events are now available through `wiseppc-live`.

### wiseppc-live (new, opt-in)

- Install it instead of `wiseppc`, never both. It signs in by itself (browser, loopback sign-in) and gives you the same WisePPC tools.
- It pushes WisePPC events into your Claude Code session as a channel: approvals, rejections, completions, failures and comments for changes made in that session, plus listing and catalog changes for the Amazon seller accounts the connection can read.
- No separate event permission is needed.
- Requires Node.js 20 or later.
- Channels are a Claude Code research preview. Start Claude Code with `claude --dangerously-load-development-channels plugin:wiseppc-live@<marketplace>`, or ask an organization admin to allow the plugin through `allowedChannelPlugins`. The tools work without channels.

## 0.1.2 - 2026-10-07

- The plugin manifest now declares the MIT license too (0.1.1 changed the LICENSE file but left the manifest saying `UNLICENSED`).

## 0.1.1 - 2026-10-07

- The plugin is now released under the MIT license: you may use, copy, modify and redistribute it without restriction.

## 0.1.0 - 2026-10-07

First public release of the WisePPC plugin for Claude Code.

- Connects Claude Code to the WisePPC MCP server at https://mcp.wiseppc.com/mcp for Amazon Ads and seller analytics.
- Authenticates with a WisePPC API key created in the WisePPC webapp, entered in Claude's secure plugin configuration field.
- Three skills: connect (check access and the available tools), analytics (structured dataset discovery and queries), and mutations (submit changes, track their status, and fix and revise a failed change).
- Changes follow your API key's grants: each granted write is either approved by a person in WisePPC or sent directly.
