# WisePPC for Claude Code

Connect Claude Code to **WisePPC** (`https://mcp.wiseppc.com/mcp`) for Amazon Ads and seller analytics, and
submit changes to your Amazon account through WisePPC. The plugin provides the WisePPC MCP tools and
three skills. It does not install or run any local code.

## Requirements

- A **WisePPC account** with an active subscription. Sign up at [wiseppc.com](https://wiseppc.com);
  see [wiseppc.com/ai-integration](https://wiseppc.com/ai-integration/) for the AI integration.
- **Amazon Ads** connected in the [WisePPC webapp](https://app.wiseppc.com). Sellers who also connect
  **Seller Central** get seller analytics (sales, traffic, economics, brand analytics); KDP authors have
  advertising datasets only.
- A WisePPC **API key** (see below).
- Claude Code with plugin support. The plugin was validated with Claude Code 2.1.288. Node.js is not
  needed to use it; it is only needed to build from source (Node 22 or later).

## Install

```text
/plugin marketplace add wiseppc/claude-code-plugin
/plugin install wiseppc@wiseppc
```

### Create and configure your API key

1. Sign in to [app.wiseppc.com](https://app.wiseppc.com) and open the **API keys** page.
2. Create a key (it starts with `wpp_ak_`). The key's permissions decide what Claude can read and change.
3. Enter the key in Claude's plugin configuration dialog when you enable the plugin. It is stored as a
   sensitive value and sent only as a Bearer token to `https://mcp.wiseppc.com/mcp`.

Never paste the key into chat, commits or logs. The plugin does not create keys or change permissions.
If the WisePPC MCP server is already configured in Claude Code (check `/mcp`), keep only one active
connection: disable one of them with Claude's MCP controls. The plugin never edits your existing
Claude configuration.

## What it does

- **MCP tools** to list your accounts and profiles, discover datasets, run structured analytics queries
  (and raw SQL reads where your key allows), read your account's preferences and runbooks, and review
  your queued changes.
- **Skills**
  - `/wiseppc:connect`: check the connection, the tools available to your key and what it is allowed to do.
  - `/wiseppc:analytics`: discover datasets and answer performance questions from live data, with
    the date range, marketplace, grain and data freshness stated.
  - `/wiseppc:mutations`: queue requested changes (bids, budgets, states, negatives and more), track
    their status, and fix and revise a change that failed.

## Changes follow your key's grants

Each write permission on your API key is either **gated** (a person approves the change in WisePPC) or
**direct** (queued and sent without review). The grant decides, not the request. A completed change means
the change was accepted for sending; confirm the resulting state with a read when it matters. When a
change fails, Claude reads the reason and can submit a corrected revision, which always waits for a person's
approval. A refusal names the missing permission; widening a key is up to the key's owner.

## First steps

1. Ask Claude to run `/wiseppc:connect`.
2. Pick a profile, then let Claude load your session context once at the start of the session.
3. Ask a question, for example "How did my Sponsored Products campaigns perform last week compared to the
   week before?"

## Update and uninstall

Update from Claude's `/plugin` menu. Uninstall with `/plugin uninstall wiseppc@wiseppc`; this does not
change your WisePPC account or your API key's permissions. Revoke keys on the API keys page of the webapp.

## License

Proprietary. All Rights Reserved. Crystal Logistics Corp / WisePPC. See [LICENSE](LICENSE).

## Building from source

For contributors with repository access: `npm ci --ignore-scripts`, `npm test`, `npm run validate`, then
`npm run build` produces the installable marketplace in `dist/wiseppc-VERSION`.
