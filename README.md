# Money Factory

A local, game-style dashboard where AI agents research, validate and (carefully) execute realistic ways to earn money. Every agent is a pixel-art worker on a factory floor. Ideas travel as crates from the **Loading Dock** through the **Research Lab**, **Market Scanner** and **Validation Bench** to the **Vault** (approved, with a report and execution plan) or the **Scrap Heap** (rejected, with the reason). Approved plans are carried out in the **Execution Yard** using your PayBox wallet and AgentMail inbox, behind permission tiers, caps, approvals and a kill switch. Every new strategy starts in **paper mode**.

> Status: phases 1–5 (paper mode only). Live execution (phase 6) is disabled until you review paper results and set `ENABLE_LIVE=true`.

## Quick start

Requirements: Node 22+, npm 10+.

```bash
git clone <this repo> && cd <repo>
npm install
cp .env.example .env

# Try it with fake agents and a fake wallet/inbox ($0):
npm run dev:mock
# open http://localhost:5173 (the plain pipeline view is at /debug)
```

### Run with real agents

Pick one way to pay for the agents:

| Option | How | Notes |
|---|---|---|
| **Claude subscription** (Pro/Max) | Install Claude Code and run `claude login` once. Leave `ANTHROPIC_API_KEY` empty. | Usage counts against your plan's limits. The app defaults to Sonnet for every role and one worker, and backs off for 10 min when it hits a usage limit. The "fuel" gauge shows API-equivalent cost as a throttle. Anthropic's terms restrict using subscription login in products offered to others; this app is for your own personal use, so check the current terms yourself. |
| **API key** | Set `ANTHROPIC_API_KEY` in `.env`. | Billed per token. The daily budget cap in Settings is a hard stop. |

Then:

```bash
npm run dev      # dev servers: API on :8787, UI on :5173
# or
npm start        # build the UI and serve everything from http://localhost:8787
```

### Connect your wallet and inbox (Execution Yard)

1. `cp config/mcp.example.json config/mcp.json` (gitignored).
2. **AgentMail:** create an API key in AgentMail and set `AGENTMAIL_API_KEY` in `.env`. The template uses the hosted MCP endpoint `https://mcp.agentmail.to/mcp`.
3. **PayBox:** set `PAYBOX_MCP_URL` and `PAYBOX_TOKEN` in `.env` to your PayBox MCP endpoint and access token (see PayBox's connector settings). Keep your PayBox credential on an approval mode (not `autonomous`) so live transfers also need your signature in PayBox: a second gate.
4. Restart, then open **Settings → MCP tools**. Every tool is listed with its tier. Tools the built-in map knows are ready; anything it had to guess is **blocked until you review it**.
5. Add allowlist entries (email domains/addresses, wallet addresses per chain, x402 hosts). Tier-1 auto actions only ever go to allowlisted recipients.

With `MOCK_AGENTS=1` and no `config/mcp.json`, the bundled fake PayBox and AgentMail servers are used instead. They include a scam airdrop token and a prompt-injection email so you can watch the defences work.

## How it works

```
Dock ─► Research ─► Market ─► Validation ─┬─► Vault (report + plan) ─► Execution Yard (paper → live)
                                          └─► Scrap (reason)
```

- **Auto mode:** a scheduler keeps N workers busy. When the dock is empty, a Scout proposes new ideas from your profile and past results. Your available capital grows with realized live P&L, so ideas scale up as strategies prove themselves.
- **Manual mode:** type an idea in "Drop a crate" at the bottom. Tick *Priority* to jump the queue.
- Each stage has its own system prompt (`apps/server/src/agents/prompts/`) and a JSON output schema (`packages/shared/src/schemas/stages.ts`). Every run stores its full transcript, sources, tool calls, tokens and cost.
- **Hard gates in code:** a high-severity red flag (MLM, guaranteed returns, pyramid, …) from any stage scraps the idea; so does a reject verdict or a weighted score under the threshold (weights and threshold are in Settings).

### Safety model

| Layer | What it does |
|---|---|
| Role separation | Scout/Research/Market/Validation get only WebSearch + WebFetch, with no MCP servers at all. The Planner gets no tools. Executors get only the `yard` gateway: no web, no shell, no files. |
| Yard gateway | The only path to wallet/email: a local MCP server with an unguessable URL per run. Every call is tiered, checked against the plan step, caps and allowlists, simulated in paper mode, and written to the audit log. |
| Tiers | **0** read-only, auto · **1** auto within caps (per action $10, per day $50), allowlisted recipients only, and only after you've approved that action type once · **2** needs your approval (shown in the Awaiting Approval tray with a dry run) · **3** blocked (secrets, card numbers, account changes, bridges, unlimited allowances, raw/permit/7702 signatures, unreviewed tools). |
| Approvals | Approving runs exactly the stored call. No LLM is involved after you click. |
| Taint | Once an executor reads untrusted content (email bodies, paid API responses), its remaining tier-1 actions in that run need approval. |
| Injection scanner | Instruction-like text ("ignore previous instructions", "send funds to …") in any agent output or tool result freezes that crate or plan for your review. |
| Paper mode | Every strategy starts simulated. Promoting to live requires `ENABLE_LIVE=true`, plus typing the strategy's name. A changed plan drops it back to paper. |
| Budget | Daily API budget: when it's hit, all workers clock out and auto mode turns off. |
| Kill switch | Aborts every agent, revokes all execution, expires pending approvals, turns auto mode off. Stays engaged until you re-arm it. |
| Audit log | Every tool call, decision and setting change is stored hash-chained and append-only (database triggers block edits and deletes). Use Settings → Audit → *Verify chain*. |

## Phone notifications

Set an ntfy topic URL in Settings (e.g. `https://ntfy.sh/money-factory-<random>`) and subscribe to it in the ntfy app. You'll get a push for every approval. Tapping it opens the app on that card.

## Project layout

```
packages/shared     types, WebSocket events, Zod schemas for every agent output
apps/server         Fastify + ws + SQLite, agent runner, pipeline, yard gateway, safety
apps/web            React + Tailwind panels, PixiJS factory scene (src/factory)
assets/             sprite sheets (regenerate with `npm run assets`, or replace with your own)
config/             MCP server config (mcp.json, gitignored)
docs/DESIGN.md      architecture, DB schema, prompts, tier mapping
```

## Scripts

| Command | What |
|---|---|
| `npm run dev:mock` | everything with mock agents and mock wallet/inbox |
| `npm run dev` | dev servers with real agents |
| `npm start` | production build served from :8787 |
| `npm test` | backend test suite |
| `npm run typecheck` | TypeScript across all packages |
| `npm run assets` | regenerate the pixel-art sprite sheets |

Data lives in `data/money-factory.db` (SQLite). Delete it to start fresh. The audit log can't be edited from inside the app.
