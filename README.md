# Claude Code Token Lens

[🇨🇳 中文版 (Chinese Version)](./README_zh.md)

![Claude Code Token Lens](public/dashboard_preview.png)

**Claude Code Token Lens** is a local desktop app that shows you what your Claude Code usage actually costs — broken down by project, by session, and by every single conversation.

It reads the `.jsonl` logs Claude Code already writes to `~/.claude/projects/` on your machine, and lays every prompt out side by side with its price. Once you can see which conversations cost many times what the others did, you can see what you were doing differently — and stop burning tokens on it.

## 🎯 Why this exists

Claude Code tells you how many tokens a conversation used. It never tells you what that was worth.

And a token count on its own doesn't mean much: not whether that was a lot or a little, not how it compares to the prompt before it, not which project is quietly eating your month. The usage happens, and then it's gone.

This gives you the number back — and, more importantly, something to compare it against:

- **Per project** — which repo actually costs you the most
- **Per session** — what one sitting added up to
- **Per conversation** — what that single prompt cost, listed right next to every other one
- **Per turn** — drill in and see where inside a conversation the money actually went

The totals are the same numbers all the way down, so a project's cost is exactly the sum of the prompts inside it.

## ✨ Features

- 🔍 **Compare, don't just total**: Projects → Sessions → Conversations → Turns, each level a sortable list. An expensive conversation stops being a mystery once it sits beside the cheap ones.
- 💵 **Money, not just tokens**: Every row carries a cost, priced per tier — cache reads are ~98% of your tokens and a rounding error on the bill; output tokens are the reverse.
- 🔒 **Local-first & secure**: Reads only `~/.claude/projects/`, enforced in Rust rather than in the UI. No outbound network requests, no telemetry, nothing uploaded.
- ⚡ **Fast on large logs**: The first launch scans everything and caches it; later refreshes read only the bytes appended since. Single session logs of 60MB+ open without a stall.

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
