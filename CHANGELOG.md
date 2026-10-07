# Changelog

## 0.1.1 - 2026-10-07

- The plugin is now released under the MIT license: you may use, copy, modify and redistribute it without restriction.

## 0.1.0 - 2026-10-07

First public release of the WisePPC plugin for Claude Code.

- Connects Claude Code to the WisePPC MCP server at https://mcp.wiseppc.com/mcp for Amazon Ads and seller analytics.
- Authenticates with a WisePPC API key created in the WisePPC webapp, entered in Claude's secure plugin configuration field.
- Three skills: connect (check access and the available tools), analytics (structured dataset discovery and queries), and mutations (submit changes, track their status, and fix and revise a failed change).
- Changes follow your API key's grants: each granted write is either approved by a person in WisePPC or sent directly.
