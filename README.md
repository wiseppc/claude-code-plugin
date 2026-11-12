# WisePPC for Claude Code

Amazon Ads PPC management and Seller Central analytics in Claude Code. Connect Claude Code to **WisePPC**
(`https://mcp.wiseppc.com/mcp`) to analyze campaigns, search terms, ASINs, listings, Brand Store and
Attribution, then submit bid, budget, keyword, campaign and creative asset changes through WisePPC, approved
by a person or sent directly as your connection's permissions decide. The plugin provides the WisePPC MCP
tools and three skills. The standard `wiseppc` plugin does not install or run any local code; the opt-in
`wiseppc-live` plugin runs a small local server (see "Install").

## Requirements

- A **WisePPC account** with an active subscription. Sign up at [wiseppc.com](https://wiseppc.com);
  see [wiseppc.com/mcp](https://wiseppc.com/mcp/) for the WisePPC MCP server.
- **Amazon Ads** connected in the [WisePPC webapp](https://app.wiseppc.com), for every account type below.
- Account types:
  - **Seller** (and **KDP** authors): Sellers who also connect **Seller Central** get seller analytics
    (sales, traffic, economics, brand analytics); KDP authors have advertising datasets only.
  - **Vendor** (1P): vendors have no Seller Central account, so seller analytics (sales, traffic, economics,
    listings, A+ content) do not apply; the advertising datasets do.
  - **Agency**: advertising datasets for the managed profiles; seller analytics only where Seller Central
    is connected.
- Claude Code with plugin support. The plugin was validated with Claude Code 2.1.293. Node.js is not
  needed to use it; it is only needed to build from source (Node 22 or later).

## Install

Two plugins are available in the same marketplace. **Choose one; never install both.**

```text
/plugin marketplace add wiseppc/claude-code-plugin
/plugin install wiseppc@wiseppc        # standard: tools and skills, no local code
/plugin install wiseppc-live@wiseppc   # opt-in: the same tools plus live event notifications
```

- **`wiseppc`** (recommended for most people) uses Claude Code's built-in sign-in; see "Sign in".
- **`wiseppc-live`** is installed *instead of* `wiseppc`. It runs a local Node.js server (**Node.js 20 or
  later** on your PATH) that signs in itself and pushes WisePPC events into your session as a channel:
  approvals, rejections, completions, failures and comments for changes made in that session, plus listing
  and catalog changes for the Amazon seller accounts the connection can read. No separate event permission
  is needed.

### wiseppc-live: sign in, channels and data

- **Sign in:** ask Claude to sign in to WisePPC (`wiseppc_live_login`); a browser window opens, you sign in,
  choose the business and approve. **Status:** `wiseppc_live_status` shows whether you are signed in and
  the state of events; it never shows credentials. **Sign out:** `wiseppc_live_logout` revokes the connection
  and deletes the stored sign-in. From a terminal: `node "<plugin folder>/server.mjs" login`, `logout` or `status`.
- **Enable channels:** channels are a Claude Code research preview. Start Claude Code with
  `claude --dangerously-load-development-channels plugin:wiseppc-live@wiseppc` and accept the prompt yourself,
  or have an organization admin list the plugin in `allowedChannelPlugins`. The tools work without channels.
- **Where tokens live:** `~/.wiseppc/claude-code/profiles/<profile>/oauth.json` on your computer (file
  mode 0600, directory 0700). The profile is `default` unless you set `WISEPPC_LIVE_PROFILE`.
- **What it sends, and where:** only to the configured WisePPC server (`https://mcp.wiseppc.com/mcp` unless
  you set `WISEPPC_LIVE_MCP_URL`): the OAuth sign-in and token requests, your tool calls, and event polling.
  It opens the sign-in page in your browser and listens briefly on a loopback address on your computer to
  receive the sign-in result. It sends nothing to any other destination and includes no analytics or telemetry.

## Sign in

1. Run `/mcp`, pick `wiseppc` and choose **Authenticate**.
2. The browser opens WisePPC. Sign in, choose the business and approve.
3. Back in Claude Code, run `/wiseppc:connect` to check the connection.

- **One connection is bound to one business.** To use another business, authorize again for it.
- **A new connection is read-only:** Claude never changes your Amazon account by itself. It proposes changes
  through WisePPC for a person to approve there. Owners and admins decide in WisePPC (**AI Integration →
  Connections & Permissions**) which changes a connection may propose and whether any may run without approval.
  Permission changes apply on the next call; you do not need to reconnect or start a new conversation.
- Only a signed-in person can approve a connection, and Claude never sees your password.
- If the WisePPC MCP server is already configured in Claude Code (check `/mcp`), keep only one active
  connection: disable the other with Claude's MCP controls. The plugin never edits your existing Claude
  configuration.

(`wiseppc-live` signs in by itself instead; see above.) WisePPC API keys still work for other MCP clients and for the REST API. See
[wiseppc.com/docs/mcp](https://wiseppc.com/docs/mcp/). The plugin itself needs no key.

## What it does

- **MCP tools** to list your accounts and profiles, discover datasets, run structured analytics queries
  (and raw SQL reads), read your account's preferences and runbooks, and review your queued changes.
- **Skills**
  - `/wiseppc:connect`: check the connection, its permissions and Amazon setup, and tell Seller, Vendor,
    Agency and KDP accounts apart.
  - `/wiseppc:analytics`: discover datasets and answer performance questions from live data, with the
    date range, marketplace, grain and data freshness stated.
  - `/wiseppc:mutations`: queue requested changes (bids, budgets, states, negatives, rules, Brand Store
    page ASINs, creative assets and more), track their status, and fix and revise a change that failed.

## Example prompts

- "How did my Sponsored Products campaigns perform last week compared to the week before? Break it down
  by campaign and show spend, sales and ACOS."
- "Find search terms that spent over $20 in the last 30 days with no orders, and suggest which to negate."
- "Lower the bid on keyword X in campaign Y to $0.80 and explain why." The change is queued; whether a
  person approves it first is decided by your connection's permissions.
- "Which of my ASINs have ad spend but are low on stock?"

## Changes follow your connection's permissions

Each write permission on your connection is either **gated** (a person approves the change in WisePPC) or
**direct** (queued and sent without review). The permission decides, not the request. A completed change
means the change was accepted for sending; confirm the resulting state with a read when it matters. When
a change fails, Claude reads the reason and can submit a corrected revision, which always waits for a
person's approval. A refusal names the missing permission; widening it is up to a business owner or admin.
Publishing a Brand Store page is not available; only the page draft can be changed.

## Update and uninstall

Update from Claude's `/plugin` menu. Uninstall with `/plugin uninstall wiseppc@wiseppc` (or `wiseppc-live@wiseppc`); this does not
change your WisePPC account or your connection's permissions. Revoke a connection in the
webapp under **AI Integration → Connections & Permissions**.

## Support and legal

- Documentation: [wiseppc.com/docs/mcp](https://wiseppc.com/docs/mcp/)
- Product page: [wiseppc.com/mcp](https://wiseppc.com/mcp/)
- Support: [wiseppc.com/about-us/#contact](https://wiseppc.com/about-us/#contact)
- [Privacy policy](https://wiseppc.com/privacy-policy/)
- [Terms of service](https://wiseppc.com/terms-of-service/)

## License

MIT. Copyright (c) 2026 Crystal Logistics Corp / WisePPC. See [LICENSE](LICENSE).

## Building from source

For contributors with repository access: `npm ci --ignore-scripts`, `npm test`, `npm run validate`, then
`npm run build` produces the installable marketplace in `dist/wiseppc-VERSION`.
