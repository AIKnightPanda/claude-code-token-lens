# Claude Code Token Lens

[🇨🇳 中文版 (Chinese Version)](./README_zh.md)

![Claude Code Token Lens](public/dashboard_preview.png)

**Claude Code Token Lens** is a beautiful, local-first token usage tracker and analytics dashboard for AI coding agents. 

Initially built to parse local logs for **Claude Code**, the architecture is designed to be platform-agnostic, allowing future support for other AI agents (Cursor, Aider, GitHub Copilot CLI, etc.). It aggregates token usage, calculates exact costs, and visualizes daily trends with rich, interactive drill-down capabilities (Project > Session > Conversation > Turns).

## 🎯 Why this exists

While you work, Claude Code tells you nothing about what it costs. Not what this conversation just spent, not whether that was a lot or a little, not which project is quietly eating your month. The usage happens, and then it's gone.

This gives you the number back — and, more importantly, something to compare it against:

- **Per project** — which repo actually costs you the most
- **Per session** — what one sitting added up to
- **Per conversation** — what that single prompt cost, listed right next to every other one
- **Per turn** — drill in and see where inside a conversation the money actually went

Because it all sits in one sortable list, an expensive conversation stops being a mystery. You can see it beside the cheap ones and work out what was different — and the totals are the same numbers all the way down, so a project's cost is exactly the sum of the prompts inside it.

## ✨ Features

- 🔒 **Local-First & Secure**: Runs entirely on your local machine. It reads your agent's local JSON logs without sending your private codebase or prompt history to any external server. Your data stays yours.
- 📊 **Detailed Dashboards**: View your total cost, token consumption, and active days at a glance through a modern, glassmorphism-inspired UI.
- 📈 **Daily Trends**: A cost trend line plus a per-day usage log, filterable to the last 7 / 30 days.
- ⚖️ **Volume vs Cost**: Token share and cost share side by side. Cache reads routinely account for ~98% of tokens but a fraction of the bill, while output tokens are the reverse — the chart shows that mismatch and the effective $/M rate for each tier.
- 🔍 **Deep Drill-Down UI**: Seamlessly filter and navigate from **Projects** -> **Sessions** -> **Conversations** -> **Individual Turns**.
- 🏷️ **Smart Filtering**: Inline filter bubbles make it easy to see exactly what context you are viewing, with one-click clearing.
- 💵 **Accurate Cost Accounting**: Deduplicates the log's repeated `usage` records, prices 5-minute and 1-hour cache writes separately, and accounts for fast-mode and server-tool billing.
- ✅ **Verifiable**: `npm run verify` recomputes every figure from the raw logs with an independent code path and asserts that all aggregation layers agree.

## 🚀 Getting Started

It ships as a desktop app (built with [Tauri](https://tauri.app/)). No server, no browser tab, no Node.js on your machine.

### Download

Grab the latest installer from the [Releases page](https://github.com/AIKnightPanda/claude-code-token-lens/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon **and** Intel) | `Claude Code Token Lens_<version>_universal.dmg` |
| Windows 10/11 (x64) | `Claude Code Token Lens_<version>_x64-setup.exe` (or the `.msi`) |

The macOS build is signed with a Developer ID certificate and notarized by Apple, so it opens with a
double-click. The Windows build is unsigned — on the SmartScreen dialog, click *More info* → *Run anyway*.

On first launch the app scans `~/.claude/projects/`, then caches the result; later refreshes only read the bytes appended since the last run.

### Build from source

Prerequisites: [Node.js](https://nodejs.org/) 18+, the [Rust toolchain](https://rustup.rs/), and the platform's
build tools ([Xcode Command Line Tools](https://developer.apple.com/xcode/resources/) on macOS,
[MSVC + WebView2](https://tauri.app/start/prerequisites/) on Windows).

```bash
git clone https://github.com/AIKnightPanda/claude-code-token-lens.git
cd claude-code-token-lens
npm install

npm run tauri:dev     # run the desktop app with hot reload
npm run tauri:build   # produce an installer in src-tauri/target/release/bundle/
```

To check the numbers yourself (runs in Node against the same parser the app uses):

```bash
npm run verify
```


## ⚙️ Configuration

The desktop app needs no configuration. These environment variables only affect the Node-side
tooling (`npm run verify`) and the defaults compiled into the app.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to read logs from |
| `TOKEN_LENS_DEDUP_SCOPE` | `global` | `global` or `session` — see "How costs are computed" |
| `TOKEN_LENS_STORE_PROMPTS` | `true` | Set to `false` to keep no prompt text on disk |
| `TOKEN_LENS_PROMPT_MAX_CHARS` | `10000` | Characters kept per prompt |

## 🔒 Privacy

The app makes **no outbound network requests** — nothing is uploaded, and there is no telemetry. Two things are worth knowing anyway:

- **The app only ever reads `~/.claude/projects/`.** That restriction is enforced in Rust, not in the UI: the desktop build exposes no general file-system API to the web layer, and every read is checked against that directory.
- **The cache holds prompt text.** `usage_cache.json` keeps the first 10,000 characters of each prompt so the Conversations view can show them. It lives in the app data directory —
  `~/Library/Application Support/com.aiknightpanda.claude-code-token-lens/` on macOS,
  `%APPDATA%\\com.aiknightpanda.claude-code-token-lens\\` on Windows — and deleting that folder clears everything the app has stored. The per-session files under `turns/` only ever contain token counts.

## 📐 How costs are computed

**These are API-equivalent costs.** They are derived from token counts at published API rates. On a Pro/Max subscription you are not billed per token, so read the number as a measure of usage scale, not as an invoice.

Three details matter for getting the number right:

**Deduplication.** A single API response is written to the log as several lines — one per content block (`thinking`, `text`, each `tool_use`) — and *every one of them carries the same `usage` object*. Counting lines therefore bills one response many times. Turns are deduplicated on `message.id` + `requestId`; on a collision the record with the larger token count wins, because copied transcripts can contain a zeroed-out placeholder alongside the real one.

`TOKEN_LENS_DEDUP_SCOPE` controls how far deduplication reaches:

| Value | Key | Behaviour |
|---|---|---|
| `global` (default) | `message.id` + `requestId` | Also removes history replayed into a new file when a session is resumed or forked. Closest to the real bill. Inherited history is attributed to the session where it first appeared, so a resumed session looks cheaper. |
| `session` | `message.id` + `requestId` + `sessionId` | Matches ccusage. Each session's total stands alone, but resumed history is counted again. |

On a typical log set the two differ by roughly 20%.

**Cache tiers.** `cache_creation` distinguishes 5-minute from 1-hour cache writes; they are billed at 1.25× and 2× the input rate respectively. Collapsing them into one rate understates cost, and in practice most Claude Code cache writes are the 1-hour tier.

**Single source of truth.** Session, project, conversation, and daily figures are all derived from the same deduplicated turn records, so every level of the dashboard adds up to the same total.

### What the logs cannot tell you

Claude Code writes token usage only on `assistant` entries. Two kinds of billable work never get a usage record, so **no tool that reads these logs — this one or ccusage — can price them**:

- **Context compaction** (`/compact`). The summarisation call is real and billed, but its usage is absent. What *is* recorded is the scale: a `compact_boundary` entry carries `preTokens`/`postTokens`. Those rows are shown with the context size that was compacted and a cost of *not measurable*, rather than a misleading `$0.00` — the call happened and was billed; there is simply no way to measure it from the logs.
- **Session title generation** (`ai-title`). Only the resulting string is stored.

Everything else that hits the API — including sub-agent turns and skill-assisted turns — is an `assistant` entry and is counted.

### Commands are kept, not hidden

Slash commands you run (`/compact`, `/init`, `/prd-as-code`, …) appear as their own rows, tagged **Command**, with whatever cost the log attributes to them — `/compact` also shows how much context it collapsed. Commands that cost nothing and merely change a local setting (`/model`, `/context`, `/agents`) are left out; they would be a column of `$0.00` noise.

Background wake-ups are not conversations. When a background command or a `Monitor` finishes, Claude Code delivers a `<task-notification>` that wakes the session and Claude keeps working. That is a continuation of whatever prompt of yours started the job, so its turns roll up into that prompt rather than appearing as a separate row; drill into the turns to see which task woke each one, tagged **Woken by background task**.

Everything else machine-generated is filtered out of the conversation list: skill bodies injected as `isMeta`, compaction summaries (`isCompactSummary`), local command output, `<system-reminder>` blocks, and interruption placeholders. Filtering changes *attribution only* — the token and cost totals are byte-identical with the filter on or off.

## 🛣️ Roadmap

- [x] Claude Code (`.claude/projects/`) log parsing support
- [x] Date-range filtering (Last 7 / 30 days, All time)
- [ ] Add support for Cursor AI logs
- [ ] Add support for Aider logs
- [ ] Custom pricing configuration interface

## 🙏 Acknowledgements / Inspiration

This project was inspired by the need to track API costs generated by autonomous coding agents. The initial parser logic was inspired by community efforts to demystify local `.jsonl` logs generated by tools like Claude Code.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
