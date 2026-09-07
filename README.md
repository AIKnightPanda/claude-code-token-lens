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
| `TOKEN_LENS_DEDUP_SCOPE` | `global` | `global` also removes history replayed into a new file by resume/fork; `session` counts each session on its own (matches ccusage) |
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

## 🙏 Acknowledgements / Inspiration

This project was inspired by the need to track API costs generated by autonomous coding agents. The initial parser logic was inspired by community efforts to demystify local `.jsonl` logs generated by tools like Claude Code.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
