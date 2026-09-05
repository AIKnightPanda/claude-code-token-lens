# Claude Code Token Lens

[🇺🇸 English Version](./README.md)

![Claude Code Token Lens](public/dashboard_preview_CN.png)

**Claude Code Token Lens** 是一款美观、本地优先的 AI 编程助手 Token 使用量追踪器和分析面板。

本项目最初为了解析 **Claude Code** 的本地日志而构建，其底层架构设计具备平台不可知性（Platform-agnostic），未来可以轻松支持其他 AI 编程助手（如 Cursor、Aider、GitHub Copilot CLI 等）。它能汇总 Token 使用量、精确计算 API 成本，并通过丰富的交互式下钻功能（项目 > 会话 > 对话 > 轮次），将每日使用趋势可视化呈现。

## 🎯 为什么做这个

用 Claude Code 的时候，它不会告诉你花了多少钱。这次对话消耗了多少？比上一次多还是少？哪个项目在悄悄吃掉你这个月的额度？都看不到。用量就这么产生了，然后消失了。

这个工具把这个数字还给你，更重要的是给你一个**可以对比的参照**：

- **每个项目** —— 到底哪个仓库最烧钱
- **每个会话** —— 一次坐下来干完的活，总共花了多少
- **每次对话** —— 你发的那一条提示词花了多少，和其他所有对话并排列着
- **每次交互** —— 下钻进去，看清钱具体花在这次对话的哪一步

因为都在同一张可排序的列表里，一次贵得离谱的对话就不再是个谜 —— 你能把它和便宜的那些放在一起看，找出差别在哪。而且每一层的合计都严格相等：一个项目的花费，就是它里面所有提示词加起来的数。

## ✨ 特性

- 🔒 **本地优先 & 安全**：完全在您的本地机器上运行。它只读取您代理的本地 JSON 日志，绝不会将您的私有代码库或提示词（Prompt）历史发送到任何外部服务器。您的数据只属于您自己。
- 📊 **详细的分析面板**：通过充满现代感、毛玻璃（Glassmorphism）风格的 UI，一眼查看总成本、Token 消耗量以及活跃天数。
- 📈 **每日趋势**：成本趋势折线加每日消耗明细，可按近 7 天 / 30 天筛选。
- ⚖️ **用量 vs 成本**：把 token 占比和成本占比并排对照。缓存读取常年占到 token 总量的约 98%，却只花掉一小部分钱；输出 token 恰好相反。这张图把这种错位以及各档位的有效单价直接画出来。
- 🔍 **深度下钻 UI**：无缝过滤和导航，层级支持 **项目** -> **会话** -> **对话** -> **具体单次交互**。
- 🏷️ **智能过滤**：内联过滤标签，让您清晰知道当前查看的数据上下文，并支持一键清除。
- 💵 **准确的成本核算**：剔除日志中重复记录的 `usage`，区分 5 分钟与 1 小时缓存写入的不同费率，并计入 fast 模式与服务端工具的计费。
- ✅ **可自证**：`npm run verify` 会用一条独立的代码路径从原始日志重算全部数字，并断言各聚合层级完全一致。

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18 或更高版本
- 本地 AI Agent 日志（目前支持由 Claude Code 生成的 `~/.claude/projects/*.jsonl`）

### 安装步骤

1. 克隆仓库：
   ```bash
   git clone https://github.com/AIKnightPanda/claude-code-token-lens.git
   cd claude-code-token-lens
   ```

2. 安装依赖：
   ```bash
   npm install
   # 也可以使用 yarn install 或 pnpm install
   ```

### 使用方法

1. 启动本地开发服务器：
   ```bash
   npm run dev
   ```

2. 在浏览器中打开 [http://localhost:3000](http://localhost:3000)。首次加载时应用会扫描本地 `.claude` 日志目录并把结果缓存在 `data/` 下；之后的刷新只读取上次之后新追加的字节。

想自己核对数字：

```bash
npm run verify
```

## ⚙️ 配置

全部通过环境变量配置，均非必填。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | 从哪里读取日志 |
| `TOKEN_LENS_DEDUP_SCOPE` | `global` | `global` 或 `session`，见「成本是怎么算出来的」 |
| `TOKEN_LENS_STORE_PROMPTS` | `true` | 设为 `false` 则不在磁盘上保留任何提示词文本 |
| `TOKEN_LENS_PROMPT_MAX_CHARS` | `10000` | 每条提示词保留的字符数 |

## 🔒 隐私

本应用**不发起任何对外网络请求** —— 不上传数据，也没有任何遥测。但有两点仍需知悉：

- **看板没有鉴权**，而页面上会显示你的提示词、项目绝对路径和消费金额。因此 `npm run dev` 和 `npm start` 都只绑定 `127.0.0.1`，仅本机可访问。如果你自行改成监听其他地址，同一网络下的任何人都能读到全部内容。
- **缓存中含提示词原文。** `data/usage_cache.json` 会保存每条提示词的前 10,000 个字符（由 `TOKEN_LENS_PROMPT_MAX_CHARS` 控制），供「对话」页展示。`data/` 已在 gitignore 中。设置 `TOKEN_LENS_STORE_PROMPTS=false` 可完全不保存；删除 `data/` 目录可清除已有内容。`data/turns/` 下的分片文件只含 token 数字，不含任何文本。

## 📐 成本是怎么算出来的

**这里显示的是「等价 API 成本」**：按官方 API 价目从 token 数推算而来。如果你用的是 Pro/Max 订阅，实际并不按 token 计费，所以这个数字应当理解为**用量规模**，而不是账单金额。

要把这个数算对，有三处关键细节：

**去重。** 一次 API 响应在日志里会被写成多行 —— 每个 content block 一行（`thinking`、`text`、每个 `tool_use`）—— 而**每一行都携带同一份 `usage`**。按行累加等于把同一次响应重复计费。本项目以 `message.id` + `requestId` 为键去重；同键冲突时保留 token 更大的那条，因为被复制的转录里可能同时存在一份真实记录和一份数值全为 0 的占位副本。

`TOKEN_LENS_DEDUP_SCOPE` 控制去重的作用范围：

| 取值 | 去重键 | 行为 |
|---|---|---|
| `global`（默认） | `message.id` + `requestId` | 连 resume/fork 时被复制进新文件的历史一并消除，最接近真实账单。被继承的历史会归属到它最早出现的那个 session，因此被 resume 的会话看起来会「变便宜」。 |
| `session` | `message.id` + `requestId` + `sessionId` | 与 ccusage 一致。每个 session 的数字独立自洽，但 resume 重放的历史会被算两次。 |

在常见的日志量下，两档相差约 20%。

**缓存分档。** `cache_creation` 区分 5 分钟与 1 小时两种缓存写入，费率分别是输入价的 1.25 倍和 2 倍。把两者合并成一个费率会低估成本，而实际使用中 Claude Code 的缓存写入绝大部分属于 1 小时档。

**单一事实源。** session、project、conversation、daily 的数字全部由同一批已去重的 turn 记录派生，因此看板上每一层的合计必然相等。

### 日志本身缺失的部分

Claude Code 只在 `assistant` 条目上写 token 用量。有两类真实计费的调用**没有任何用量记录**，因此任何基于这些日志的工具（本项目和 ccusage 都一样）都无法为其计价：

- **上下文压缩**（`/compact`）。总结调用真实发生且会计费，但用量缺失。日志里**有**的是规模：`compact_boundary` 条目带着 `preTokens` / `postTokens`。这类记录会显示被压缩的上下文体量，成本标为**无法统计**，而不是误导性的 `$0.00` —— 这次调用确实发生并计费了，只是没办法从日志里统计出来。
- **会话标题生成**（`ai-title`）。只存下了生成结果这个字符串。

除此之外所有打到 API 的调用 —— 包括子 agent 轮次和技能加载后的轮次 —— 都是 `assistant` 条目，都已计入。

### 指令会保留，不会被隐藏

你执行的斜杠命令（`/compact`、`/init`、`/prd-as-code` 等）会作为独立记录出现，带 **指令** 标记，并显示日志归属给它的真实成本；`/compact` 还会附带这次压缩掉了多少上下文。不产生任何开销、只改本地设置的命令（`/model`、`/context`、`/agents`）不展示 —— 留在列表里只是一堆 `$0.00` 噪音。

后台唤醒不算一次对话。后台命令或 `Monitor` 结束时，Claude Code 会投递一条 `<task-notification>` 唤醒会话让 Claude 继续干活。那是你某次提问所发起工作的延续，因此这些轮次会归并到那条提问下，而不单独占一行；下钻到交互明细即可看到是哪个任务唤醒的，带 **后台任务唤醒** 标记。

其余由机器生成的内容都不进对话列表：以 `isMeta` 注入的技能正文、压缩摘要（`isCompactSummary`）、命令的本地输出、`<system-reminder>` 块、以及中断占位。过滤**只改变归属**，token 与成本总额在开关过滤前后逐位相同（已实测）。

## 🛣️ 路线图

- [x] 支持 Claude Code (`.claude/projects/`) 日志解析
- [x] 日期范围过滤（最近 7 天 / 30 天 / 全部）
- [ ] 增加对 Cursor AI 日志的支持
- [ ] 增加对 Aider 日志的支持
- [ ] 自定义定价配置界面

## 🙏 致谢 / 灵感来源

本项目的灵感来自于对自动化编程助手所产生的 API 成本进行追踪的迫切需求。初始的解析逻辑受启发于社区为了解 Claude Code 等工具生成的本地 `.jsonl` 日志所做的努力。

## 📄 许可证

本项目基于 MIT 许可证开源 - 详情请参阅 [LICENSE](LICENSE) 文件。
