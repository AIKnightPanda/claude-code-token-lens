import { extractTokens, calculateCostBreakdown, getPricing } from './pricing-codex.js';

/**
 * Codex（本机「ChatGPT 桌面版」实际读取的数据源）解析与聚合。
 *
 * 这个文件和 ./parser.js 是两套完全独立的实现，故意不共享任何状态或缓存路径 ——
 * 用户明确要求两边数据分离，一边出错不能影响另一边。唯一共用的是 UI 层
 * （app/page.js）和 i18n 文案，因为两边的概念能对齐：
 *
 *   Claude Code            Codex（rollout jsonl）
 *   session（一个 jsonl）    session（一个 rollout-*.jsonl）
 *   project（cwd）          project（session_meta.cwd / turn_context.cwd）
 *   conversation（一次提问） turn（一个 turn_id：一次提问到 task_complete）
 *   turn（一次 API 响应）    token_count 事件（一次模型调用的用量增量）
 *
 * 已知的简化（相对 ccusage 的 Codex adapter）：
 *   - 不做 fork/resume 的跨文件用量重放去重：本机实测 fork 出来的日志只复制历史
 *     消息，不复制 token_count 事件（7 个文件互相比对，重复用量事件为 0），所以
 *     不会重复计费，暂时不需要去重。
 *   - 用户提问时派生的子 agent（session_meta.source.subagent.thread_spawn）各写一份
 *     独立的 rollout，开头还带着父会话的历史。它们不当作独立会话展示，而是把用量
 *     并回根会话、挂到派出它时正在进行的那条提问下，与 Claude 侧对子 agent 的处理
 *     一致（见 attachSubagents）。
 *   - service_tier 只用于展示（Turns 页的 fast 徽章），不叠加价格倍数 ——
 *     没有公开资料确认 Codex priority 档的具体溢价比例，不编造倍数。
 *   - 不还原 compaction 的规模：Codex 的压缩事件里没有 Claude 那种
 *     preTokens/postTokens 数值字段，只有替换后的完整历史，没法简单转成一个数字。
 */
let io = null;

export function setIO(impl) {
  io = impl;
}

function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};

export const CODEX_CACHE_VERSION = 5;

/** cwd 识别不出真实项目时用这个固定键归到「未分类」桶，而不是各自冒充一个项目。 */
export const UNASSIGNED_PROJECT_KEY = '__codex_unassigned__';

/** 安全检查子调用合并进的对话种类，UI 据此显示专门的徽章而不是当成一条用户提问。 */
export const INTERNAL_CHECK_KIND = 'internal-check';

export const CODEX_STORE_PROMPTS = env.TOKEN_LENS_CODEX_STORE_PROMPTS !== 'false';

const PROMPT_MAX_CHARS = Number(env.TOKEN_LENS_CODEX_PROMPT_MAX_CHARS) || 10000;

export function getCodexHomeDir() {
  return io.homeDir();
}

/** 本地时区的 YYYY-MM-DD，与 parser.js 的同名函数逻辑一致但独立实现。 */
export function toLocalDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function emptyCache() {
  return {
    version: CODEX_CACHE_VERSION,
    generatedAt: null,
    storePrompts: CODEX_STORE_PROMPTS,
    fileRegistry: {},
    sessions: {},
    conversations: {},
    projects: [],
    daily: [],
    summary: {},
    stats: {},
  };
}

export async function readCache() {
  let raw;
  try {
    raw = await io.readCache();
  } catch (err) {
    return { cache: emptyCache(), rebuildReason: 'unreadable-cache: ' + errText(err) };
  }
  if (raw == null) return { cache: emptyCache(), rebuildReason: 'no-cache' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== CODEX_CACHE_VERSION || parsed.storePrompts !== CODEX_STORE_PROMPTS) {
      return { cache: emptyCache(), rebuildReason: 'cache-version-changed' };
    }
    return { cache: Object.assign(emptyCache(), parsed), rebuildReason: null };
  } catch (err) {
    return { cache: emptyCache(), rebuildReason: 'unreadable-cache: ' + errText(err) };
  }
}

async function writeCache(cache) {
  await io.writeCache(JSON.stringify(cache));
}

export async function readTurnsShard(sessionId) {
  try {
    const raw = await io.readTurns(sessionId);
    if (raw == null) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** conversationId 形如 "<sessionId>:<turnId>"，能直接反解出所在分片。 */
export async function getTurnsForConversation(conversationId) {
  if (!conversationId) return [];
  const { cache } = await readCache();
  const conv = cache.conversations[conversationId];
  const sessionId = (conv && conv.sessionId) || String(conversationId).split(':')[0];
  if (!cache.sessions[sessionId]) return [];
  const out = [];
  for (const t of await readTurnsShard(sessionId)) {
    if (t.conversationId === conversationId) out.push(t);
  }
  // 并入这条提问的子 agent：把它们的调用也列出来，标上是哪个子 agent 发的。
  for (const sub of Object.values(cache.sessions)) {
    const at = sub.attachedTo;
    if (!at || at.conversationId !== conversationId) continue;
    const agent = [sub.subagent.nickname, sub.subagent.path && sub.subagent.path.replace(/^\/root\//, '')]
      .filter(Boolean).join(' · ');
    for (const t of await readTurnsShard(sub.sessionId)) {
      out.push({ ...t, sessionId, conversationId, subagent: sub.subagent.nickname || 'subagent', agent });
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return out;
}

async function writeTurnsShard(sessionId, turns) {
  if (!turns.length) {
    await io.removeTurns(sessionId);
    return;
  }
  await io.writeTurns(sessionId, JSON.stringify(turns));
}

/**
 * Codex 会把一批系统注入的上下文也写成 role:"user" 的 response_item：
 * 环境信息、内部续接目标、推荐插件列表、本地命令的输出回显……
 * 这些不是用户打的字，过滤方式和 Claude Code 那边的 SYSTEM_TEXT_PREFIXES 同思路，
 * 只是标签名不同（两边巧合地共用了 <local-command-stdout> 这个标签）。
 */
const SYSTEM_TEXT_PREFIXES = [
  '<codex_internal_context',
  '<environment_context',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<recommended_plugins>',
  '<system-reminder>',
  '<task-notification>',
];

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  }
  return '';
}

function isSystemInjectedText(text) {
  const head = text.trimStart();
  return SYSTEM_TEXT_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * 安全评估子调用固定的提示词模板，已知两种变体都以这句开头
 * （"...history added since your last approval" / "...history whose request action..."）。
 * 是英文系统模板，不随界面语言变化，用来识别没有伴生 user_message 事件的那部分。
 */
function isSafetyCheckPromptText(text) {
  return text.trimStart().startsWith('The following is the Codex agent history');
}

/** 斜杠命令（/model、/compact…）是用户的真实操作，标签格式与 Claude Code 一致。 */
function isSlashCommandText(text) {
  const head = text.trimStart();
  return head.startsWith('<command-name>') || head.startsWith('<command-message>');
}

/**
 * "目标模式"续轮提示：<codex_internal_context source="goal"> 包着的固定模板，
 * 真正有意义的内容在内嵌的 <objective> 标签里——是这个 thread 当前追的目标，
 * 不是无意义的系统噪音，不能被下面通用的 <codex_internal_context 前缀规则连带吃掉，
 * 否则这一轮就会显示成空提示词。
 */
function isGoalContinuationText(text) {
  return text.trimStart().startsWith('<codex_internal_context source="goal"');
}

function extractGoalObjective(text) {
  const m = text.match(/<objective>([\s\S]*?)<\/objective>/);
  return m ? m[1].trim() : text;
}

function extractPromptText(text) {
  const name = text.match(/<command-(?:name|message)>([\s\S]*?)<\/command-(?:name|message)>/);
  if (!name) return text;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const label = name[1].trim();
  const argText = args ? args[1].trim() : '';
  const slash = label.startsWith('/') ? label : '/' + label;
  return argText ? slash + ' ' + argText : slash;
}

/**
 * session_index.jsonl 里偶尔原样存了斜杠命令的标签文本（比如用户直接输入
 * "/model" 起的会话，thread_name 会是 "<command-name>/model</command-name>"），
 * 复用同一套清洗逻辑，展示成 "/model" 而不是原始标签。
 */
function cleanThreadName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  return isSlashCommandText(trimmed) ? extractPromptText(trimmed) : trimmed;
}

/**
 * ~/.codex/session_index.jsonl：Codex 桌面版自己给每个 thread 起的标题
 * （{id, thread_name, updated_at}，一行一条），和 rollout 日志完全独立的一份索引，
 * 是目前唯一真正对应"会话名称"的数据源——event_msg:thread_goal_updated 那个字段
 * 看起来像标题，实测其实是模型当前工作目标的摘要，原文经常就是用户那一轮提示词
 * 本身（一旦用户提示里出现"Goal"这类字眼，这条目标文本会整段照抄提示词），
 * 用它当标题只会显示成一段长提示词，而不是 Codex 界面里真正显示的会话名。
 * 文件很小（一个 session 一行），每次全量读入、不做增量。
 */
function parseSessionIndex(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = entry && entry.id;
    const name = entry && cleanThreadName(entry.thread_name);
    if (id && name) map.set(id, name);
  }
  return map;
}

function baseName(p, fallback) {
  const segments = String(p || '').split(/[/\\]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : fallback;
}

/**
 * session_meta / turn_context 里的 cwd 有时是 "/a/b"，有时是同一个目录的
 * "file:///a/b" URI 形式（偶尔还带中文路径的百分号编码）。不统一会把同一个
 * 项目拆成两个 projectKey，项目列表里出现一个乱码条目、一个正常条目。
 */
function normalizeCwd(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('file://')) return raw;
  const stripped = raw.slice('file://'.length);
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

const SCRATCH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 桌面版 Codex 给「没有绑定到具体项目」的临时对话建的工作目录：
 *   <home>/Documents/Codex/<YYYY-MM-DD>/<随机短名>
 * 这些目录名本身没有意义（"ve"/"ni"/"ru" 之类两三个字母），直接取最后一段当项目名，
 * 界面上会出现用户从没见过、在 Codex 里也找不到对应项目的怪名字。这里识别出来，
 * 统一归到一个「未分类」桶，而不是各自冒充一个独立项目。
 *
 * 只按相对路径形状匹配，不依赖用户主目录本身——Tauri 的 IO 适配器不提供
 * homeDir()（桌面端的路径解析全在 Rust 侧，故意不给 JS 暴露这个能力），
 * 之前在这里调用 getCodexHomeDir() 会在桌面端直接抛异常，导致 Codex 那一侧
 * 一进来就"数据加载失败"。cwd 恰好就是用户主目录本身这种更窄的情况，
 * 就不特殊处理了，代价只是它会显示成一个叫用户名的项目，比加载失败轻得多。
 */
function isScratchCwd(cwd) {
  if (!cwd) return false;
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  const idx = parts.lastIndexOf('Codex');
  return idx > 0 && parts[idx - 1] === 'Documents' && SCRATCH_DATE_RE.test(parts[idx + 1] || '');
}

/**
 * 安全检查子调用（guardian 线程）不是每次主线程调用都重新起一个——实测同一个
 * guardian 线程会被复用好几个小时，横跨好几次完全不相关的主线程运行。直接按
 * session 合并成一条会把不同时间点、甚至被用量限额打断后隔了几个小时才重新
 * 触发的检查全部混进同一行，用户在界面上完全看不出这是两次不同的运行各自触发的。
 * 用检查之间的时间间隔分段：间隔小说明是同一次运行里连续触发的，合并；
 * 间隔一旦超过这个阈值，就认为是另一次运行触发的，开一条新的"安全检查"记录。
 * 30 分钟是按实际日志里观察到的数值定的：同一次运行内检查间隔最长不到 12 分钟，
 * 被打断后重新触发间隔通常以小时计（实测命中过 7 小时的间隔）。
 */
const INTERNAL_CHECK_GAP_MS = 30 * 60 * 1000;

/** 安全检查子调用的合成对话 id：同一段连续检查（见上）合并成一条。 */
function internalCheckConvId(sessionId, seq) {
  return sessionId + ':internal-check:' + seq;
}

function getOrCreateConv(ctx, id, timestamp, overrides) {
  let conv = ctx.conversations.get(id);
  if (!conv) {
    conv = newConversation(id, ctx.sessionId, timestamp);
    if (overrides) Object.assign(conv, overrides);
    ctx.conversations.set(id, conv);
  }
  return conv;
}

function newConversation(id, sessionId, timestamp) {
  return {
    id,
    sessionId,
    date: timestamp,
    prompt: '',
    kind: 'prompt',
    hasRealPrompt: false,
  };
}

/**
 * 识别「用户提问时派生出来的子 agent」日志。只认 thread_spawn 这一种来源：
 * guardian_review（安全检查）和其他来源的子线程有各自的处理，不能混进来。
 */
function readSpawnedSubagent(meta) {
  const spawn = meta.source && meta.source.subagent && meta.source.subagent.thread_spawn;
  if (!spawn) return null;
  return {
    nickname: spawn.agent_nickname || null,
    path: spawn.agent_path || null,
    depth: spawn.depth || null,
  };
}

/**
 * 订阅套餐的额度读数：每条 token_count 事件都带着「5 小时窗口」和「每周」两个累计百分比。
 * 只认 5 小时窗口（window_minutes = 300）——免费版是 30 天窗口，不是订阅额度，不展示。
 * 读数是整数、是账户级的累计值（不是这一次调用的消耗），单次消耗要靠相邻读数相减。
 */
function readQuota(rateLimits) {
  const primary = rateLimits && rateLimits.primary;
  if (!primary || primary.window_minutes !== 300 || typeof primary.used_percent !== 'number') return null;
  const weekly = rateLimits.secondary && rateLimits.secondary.used_percent;
  return {
    pct: primary.used_percent,
    weekly: typeof weekly === 'number' ? weekly : null,
    reset: primary.resets_at || null,
  };
}

/** 子 agent 会话沿用根会话的标题；没能并入根会话而单独展示时，加上 agent 名字免得几个会话同名。 */
function subagentSessionName(name, subagent) {
  if (!name || !subagent || !subagent.nickname) return name || null;
  return name + ' · ' + subagent.nickname;
}

/** 把 total_token_usage 的累计值相减，算出这次调用相对上次的增量。 */
function subtractUsage(total, prev) {
  const p = prev || {};
  const sub = (k) => Math.max((total[k] || 0) - (p[k] || 0), 0);
  return {
    input_tokens: sub('input_tokens'),
    cached_input_tokens: sub('cached_input_tokens'),
    cache_write_input_tokens: sub('cache_write_input_tokens'),
    output_tokens: sub('output_tokens'),
    reasoning_output_tokens: sub('reasoning_output_tokens'),
  };
}

/** 服务等级映射：两种拼写都可能出现，取决于写日志的是 CLI 还是桌面端。 */
function normalizeServiceTier(tier) {
  if (tier === 'fast' || tier === 'priority') return 'fast';
  if (tier === 'default' || tier === 'standard') return 'standard';
  return null;
}

/** 开始（或切换到）一个 turn：turnId 变化时才新建对话记录，避免重复创建。 */
function beginTurn(ctx, turnId, timestamp) {
  if (ctx.currentTurnId === turnId && ctx.currentConvId) return;
  ctx.currentTurnId = turnId;
  const id = ctx.sessionId + ':' + turnId;
  ctx.currentConvId = id;
  if (!ctx.conversations.has(id)) {
    ctx.conversations.set(id, newConversation(id, ctx.sessionId, timestamp));
  }
}

/**
 * 流式解析单个 rollout jsonl 文件的一段区间。逐行读取，不整文件读进内存。
 */
async function parseFileRange(filePath, startOffset, ctx) {
  for await (const line of io.readLines(filePath, startOffset)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      ctx.stats.linesSkipped++;
      continue;
    }
    ctx.stats.linesParsed++;
    // 不能指望日志自带的 entry.ordinal——guardian 线程这类子 agent 日志实测有的
    // 版本完全不带这个字段（全是 undefined），用它拼 id 会导致同一份文件里
    // 所有 turn 的 id 都变成同一个 "sessionId:undefined"，React 报 key 重复，
    // 严重的话还会互相覆盖。改用自己独立维护的序号，不依赖日志格式。
    const seq = ++ctx.lineSeq;

    if (entry.timestamp) {
      ctx.lastActivity = entry.timestamp;
      if (!ctx.firstActivity) ctx.firstActivity = entry.timestamp;
    }

    const type = entry.type;
    const payload = entry.payload;

    if (type === 'session_meta') {
      // payload.session_id 是整个 thread 的根 id，跟 session_index.jsonl 的 id
      // 对得上；payload.id 才是这一份 rollout 文件自己的 id——fork/resume 出的
      // 续接文件、桌面版的安全检查子 agent 文件，payload.id 都会换成新值，
      // 但 session_id 始终指向最初那个根 thread，文件名里的 id 段因此会跟它不一致。
      if (payload && payload.session_id && !ctx.rootSessionId) ctx.rootSessionId = payload.session_id;
      if (payload && payload.id && !ctx.threadId) ctx.threadId = payload.id;
      if (payload && payload.cwd && !ctx.cwd) ctx.cwd = normalizeCwd(payload.cwd);
      if (payload && !ctx.subagent) ctx.subagent = readSpawnedSubagent(payload);
      continue;
    }

    if (type === 'turn_context') {
      if (!payload) continue;
      if (payload.cwd && !ctx.cwd) ctx.cwd = normalizeCwd(payload.cwd);
      if (payload.model) ctx.currentModel = payload.model;
      if (payload.turn_id) beginTurn(ctx, payload.turn_id, entry.timestamp);
      continue;
    }

    if (type === 'response_item') {
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;
      const raw = contentText(payload.content);
      if (!raw.trim()) continue;
      const isGoal = isGoalContinuationText(raw);
      if (!isGoal && isSystemInjectedText(raw)) {
        ctx.stats.systemPromptsSkipped++;
        continue;
      }
      if (!ctx.currentConvId) beginTurn(ctx, 'evt' + seq, entry.timestamp);
      const conv = ctx.conversations.get(ctx.currentConvId);
      // 双重信号：大多数安全检查子调用会配一条 event_msg:user_message（见下），
      // 但实测有一部分只留下这条固定模板开头的提示词、没有伴生事件——
      // 文本本身同样是可靠信号，两条路径任一命中都标记。
      if (conv && isSafetyCheckPromptText(raw)) conv.isInternalCheck = true;
      // 一个 turn 内可能不止一条用户消息（比如追加指示），只保留第一条真实文本展示。
      if (conv && !conv.hasRealPrompt) {
        const source = isGoal ? extractGoalObjective(raw) : raw;
        const isCmd = isSlashCommandText(source);
        conv.prompt = CODEX_STORE_PROMPTS ? extractPromptText(source).slice(0, PROMPT_MAX_CHARS) : '';
        conv.kind = isCmd ? 'command' : 'prompt';
        conv.hasRealPrompt = true;
        if (isGoal) conv.isGoalMode = true;
      }
      continue;
    }

    if (type !== 'event_msg' || !payload) continue;
    const sub = payload.type;

    if (sub === 'task_started') {
      if (payload.turn_id) beginTurn(ctx, payload.turn_id, entry.timestamp);
      continue;
    }

    if (sub === 'thread_settings_applied') {
      const tier = payload.thread_settings && payload.thread_settings.service_tier;
      const normalized = normalizeServiceTier(tier);
      if (normalized) ctx.currentServiceTier = normalized;
      continue;
    }

    if (sub === 'user_message') {
      // 桌面版在执行有风险的操作前会起一个独立的安全评估子调用：把完整对话历史
      // 重新打包成一条"assessing..."的提示发给分类器判断是否放行。这走的是和
      // 普通 turn 完全一样的 turn_context/token_count 事件序列，原样解析会在
      // 对话列表里冒出一串内容几乎相同的"重复记录"。用这个事件本身（而不是匹配
      // 提示词文本）作为识别信号——它只出现在这类内部子调用里，不依赖具体文案、
      // 不受语言影响。标记后，这个 turn 的用量会在 token_count 里改记到
      // 每个 session 共用的一条"安全检查"桶里，不再各自冒充一条独立对话。
      if (ctx.currentConvId) {
        const conv = ctx.conversations.get(ctx.currentConvId);
        if (conv) conv.isInternalCheck = true;
      }
      continue;
    }

    if (sub !== 'token_count') continue;
    const info = payload.info;
    if (!info) continue; // 命中用量限制等错误场景下 info 可能为 null

    const total = info.total_token_usage || null;
    let lastUsage = info.last_token_usage;
    if (!lastUsage && total) lastUsage = subtractUsage(total, ctx.prevTotal);
    if (total) ctx.prevTotal = total;
    if (!lastUsage) continue;

    const tokens = extractTokens(lastUsage);
    if (tokens.totalTokens === 0) continue;

    if (!ctx.currentConvId) beginTurn(ctx, 'evt' + seq, entry.timestamp);

    let conversationId = ctx.currentConvId;
    const activeConv = ctx.conversations.get(conversationId);
    if (activeConv && activeConv.isInternalCheck) {
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      const withinGap = ctx.internalCheckSeq
        && Number.isFinite(ctx.internalCheckLastTs) && Number.isFinite(ts)
        && ts - ctx.internalCheckLastTs <= INTERNAL_CHECK_GAP_MS;
      if (!withinGap) ctx.internalCheckSeq = (ctx.internalCheckSeq || 0) + 1;
      if (Number.isFinite(ts)) ctx.internalCheckLastTs = ts;

      conversationId = internalCheckConvId(ctx.sessionId, ctx.internalCheckSeq);
      getOrCreateConv(ctx, conversationId, entry.timestamp, {
        kind: INTERNAL_CHECK_KIND, hasRealPrompt: true, prompt: '',
      });
    }

    const model = ctx.currentModel || 'gpt-5';
    const pricing = getPricing(model);
    const breakdown = calculateCostBreakdown(tokens, model);
    const turn = {
      id: ctx.sessionId + ':' + seq,
      conversationId,
      sessionId: ctx.sessionId,
      timestamp: entry.timestamp,
      model,
      pricingEstimated: pricing.estimated,
      speed: ctx.currentServiceTier === 'fast' ? 'fast' : null,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheTokens: tokens.cacheTokens,
      totalTokens: tokens.totalTokens,
      cost: breakdown.total,
      costInput: breakdown.input,
      costOutput: breakdown.output,
      costCacheWrite: breakdown.cacheWrite,
      costCacheRead: breakdown.cacheRead,
    };
    const quota = readQuota(payload.rate_limits);
    if (quota) {
      turn.quotaPct = quota.pct;
      turn.quotaWeekly = quota.weekly;
      turn.quotaReset = quota.reset;
    }
    ctx.turnSeq++;
    ctx.turns.push(turn);
  }
}

/**
 * 增量刷新，逻辑与 parser.js 的同名函数一致（按 mtime/size 判断跳过/续读/重解析），
 * 但这里没有跨 session 的去重表——Codex 的 fork 场景本机很少见，先不处理。
 */
export async function refreshUsage({ force = false } = {}) {
  const started = Date.now();
  const { cache, rebuildReason } = await readCache();
  const fullRebuild = force || !!rebuildReason;
  if (fullRebuild) {
    cache.fileRegistry = {};
    cache.sessions = {};
    cache.conversations = {};
    await io.clearAllTurns();
  }

  const files = (await io.listLogFiles()).sort(
    (a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)
  );
  const sessionIndexMap = parseSessionIndex(await io.readSessionIndex());
  const stats = {
    filesScanned: files.length,
    filesParsed: 0,
    subagentFiles: 0,
    linesParsed: 0,
    linesSkipped: 0,
    systemPromptsSkipped: 0,
    filesRemoved: 0,
    rebuildReason,
  };

  const alive = new Set(files.map((f) => f.filePath));
  for (const registered of Object.keys(cache.fileRegistry)) {
    if (alive.has(registered)) continue;
    const sessionId = cache.fileRegistry[registered].sessionId;
    delete cache.fileRegistry[registered];
    delete cache.sessions[sessionId];
    // 挂在这个会话下的子 agent 会话，对话记录在并入时被清掉了；根会话没了，
    // 它们要从头重解析，才能作为独立会话重新出现。
    for (const [fp, r] of Object.entries(cache.fileRegistry)) {
      const s = cache.sessions[r.sessionId];
      if (s && s.attachedTo && s.attachedTo.sessionId === sessionId) delete cache.fileRegistry[fp];
    }
    for (const [cid, conv] of Object.entries(cache.conversations)) {
      if (conv.sessionId === sessionId) delete cache.conversations[cid];
    }
    await io.removeTurns(sessionId);
    stats.filesRemoved++;
  }

  for (const file of files) {
    const reg = cache.fileRegistry[file.filePath];
    let startOffset = 0;
    let resume = false;

    if (reg && !fullRebuild) {
      if (reg.mtimeMs === file.mtimeMs && reg.size === file.size) continue;
      if (file.size >= reg.size && reg.offset != null) {
        startOffset = reg.offset;
        resume = true;
      }
    }

    const sessionId = file.sessionId;
    const prev = resume ? cache.sessions[sessionId] : null;
    const existingTurns = resume ? await readTurnsShard(sessionId) : [];

    if (!resume) {
      for (const [cid, conv] of Object.entries(cache.conversations)) {
        if (conv.sessionId === sessionId) delete cache.conversations[cid];
      }
    }

    const conversations = new Map();
    if (resume) {
      for (const [cid, conv] of Object.entries(cache.conversations)) {
        if (conv.sessionId === sessionId) conversations.set(cid, conv);
      }
    }

    const ctx = {
      sessionId,
      cwd: prev ? prev.cwd : null,
      rootSessionId: reg && resume ? reg.rootSessionId : null,
      threadId: reg && resume ? reg.threadId : null,
      subagent: reg && resume ? reg.subagent : null,
      firstActivity: prev ? prev.firstActivity : null,
      lastActivity: prev ? prev.date : null,
      currentTurnId: reg && resume ? reg.currentTurnId : null,
      currentConvId: reg && resume ? reg.currentConvId : null,
      currentModel: reg && resume ? reg.currentModel : null,
      currentServiceTier: reg && resume ? reg.currentServiceTier : null,
      prevTotal: reg && resume ? reg.prevTotal : null,
      turnSeq: reg && resume ? reg.turnSeq || 0 : 0,
      lineSeq: reg && resume ? reg.lineSeq || 0 : 0,
      internalCheckSeq: reg && resume ? reg.internalCheckSeq || 0 : 0,
      internalCheckLastTs: reg && resume ? reg.internalCheckLastTs : null,
      conversations,
      turns: existingTurns.slice(),
      stats,
    };

    try {
      await parseFileRange(file.filePath, startOffset, ctx);
    } catch (err) {
      stats.linesSkipped++;
      stats.lastError = file.filePath + ': ' + errText(err);
      continue;
    }
    stats.filesParsed++;

    for (const [cid, conv] of ctx.conversations) cache.conversations[cid] = conv;
    await writeTurnsShard(sessionId, ctx.turns);

    const scratch = isScratchCwd(ctx.cwd);
    const projectKey = scratch ? UNASSIGNED_PROJECT_KEY : (ctx.cwd || file.folderName);
    cache.sessions[sessionId] = {
      sessionId,
      sessionName: subagentSessionName(sessionIndexMap.get(ctx.rootSessionId || sessionId), ctx.subagent),
      projectKey,
      projectName: scratch ? null : baseName(projectKey, file.folderName),
      cwd: ctx.cwd || null,
      threadId: ctx.threadId || null,
      rootSessionId: ctx.rootSessionId || null,
      subagent: ctx.subagent || null,
      firstActivity: ctx.firstActivity,
      date: ctx.lastActivity,
    };

    cache.fileRegistry[file.filePath] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      offset: file.size,
      sessionId,
      rootSessionId: ctx.rootSessionId,
      threadId: ctx.threadId,
      subagent: ctx.subagent,
      currentTurnId: ctx.currentTurnId,
      currentConvId: ctx.currentConvId,
      currentModel: ctx.currentModel,
      currentServiceTier: ctx.currentServiceTier,
      prevTotal: ctx.prevTotal,
      turnSeq: ctx.turnSeq,
      lineSeq: ctx.lineSeq,
      internalCheckSeq: ctx.internalCheckSeq,
      internalCheckLastTs: ctx.internalCheckLastTs,
    };
  }

  stats.subagentFiles = attachSubagents(cache);
  await deriveTotalsFromTurns(cache);
  aggregate(cache);
  cache.stats = stats;
  cache.stats.durationMs = Date.now() - started;
  cache.generatedAt = new Date().toISOString();
  await writeCache(cache);
  return cache;
}

const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheWrite: 0,
  costCacheRead: 0,
  turnCount: 0,
};

const SUM_FIELDS = Object.keys(ZERO_TOTALS).filter((k) => k !== 'turnCount');

function accumulate(target, turn) {
  for (const f of SUM_FIELDS) target[f] += turn[f] || 0;
  target.turnCount += 1;
}

/**
 * 给每个子 agent 会话找到它该并入的根会话和提问，写到 session.attachedTo。返回子 agent 会话数。
 *
 * 根会话按 session_meta.session_id 找（所有层级的子 agent 都指向最初那个根线程）；
 * 提问按派出时刻找：取根会话里开始时间不晚于子 agent 日志第一条记录的最近一条 ——
 * 子 agent 是在那条提问的回答过程中被派出来的。找不到根会话（比如被清理掉了）或
 * 根会话没有可挂的提问时不并入，仍作为独立会话展示。
 */
function attachSubagents(cache) {
  const rootByThread = new Map();
  for (const s of Object.values(cache.sessions)) {
    if (!s.subagent && s.threadId) rootByThread.set(s.threadId, s);
  }
  const convsBySession = new Map();
  for (const c of Object.values(cache.conversations)) {
    if (c.kind === INTERNAL_CHECK_KIND || !c.date) continue;
    let list = convsBySession.get(c.sessionId);
    if (!list) convsBySession.set(c.sessionId, (list = []));
    list.push(c);
  }

  let count = 0;
  for (const s of Object.values(cache.sessions)) {
    delete s.attachedTo;
    if (!s.subagent) continue;
    count++;
    const root = rootByThread.get(s.rootSessionId);
    const convs = root && convsBySession.get(root.sessionId);
    if (!convs || !convs.length) continue;
    let target = null;
    for (const c of convs) {
      if (c.date <= s.firstActivity && (!target || c.date > target.date)) target = c;
    }
    if (!target) target = convs.reduce((a, b) => (a.date <= b.date ? a : b));
    s.attachedTo = { sessionId: root.sessionId, conversationId: target.id };
  }
  return count;
}

/**
 * 每条对话占用了多少 5 小时额度（百分点，可能带小数）。
 *
 * 日志里的读数是账户级的累计整数，不是单次调用的消耗，而且是请求开始时的快照
 * （实测读数上涨与前一次调用的成本相关系数 0.56，与同一次调用只有 0.21）。这里按时间顺序
 * 扫描同一个窗口里的全部调用（不分对话、不分线程），读数每上涨一个点，就按调用成本的比例
 * 分给「上一次上涨之后、这次读数之前发生的那些调用」，再按对话汇总。这样：
 *   - 同一个窗口里所有对话的占用加起来，正好等于这个窗口读数的总上涨量；
 *   - 交错发生的对话（并行、隔很久才有一次调用的）不会把别人的消耗算到自己头上；
 *   - 误差来自读数的整数精度和并行子 agent 之间 1 到 2 个点的抖动，属于近似值。
 * 窗口里最后一次上涨之后的调用，读数还没来得及反映，暂时不计入（所以窗口最后一两次调用的消耗可能缺失）。
 */
function conversationQuotaUsage(quotaTurns) {
  const result = new Map();
  if (!quotaTurns.length) return result;

  // 同一个窗口里，不同线程报的 resets_at 会差几秒，相邻不超过 60 秒的归为一个窗口。
  const resets = Array.from(new Set(quotaTurns.map((t) => t.reset).filter((r) => r != null))).sort((a, b) => a - b);
  const windowOf = new Map();
  let anchor = null;
  let prev = null;
  for (const r of resets) {
    if (prev == null || r - prev > 60) anchor = r;
    windowOf.set(r, anchor);
    prev = r;
  }

  const byWindow = new Map();
  for (const t of quotaTurns) {
    if (t.reset == null) continue;
    const w = windowOf.get(t.reset);
    let list = byWindow.get(w);
    if (!list) byWindow.set(w, (list = []));
    list.push(t);
    if (!result.has(t.convId)) result.set(t.convId, 0);
  }

  for (const list of byWindow.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let peak = list[0].pct;
    let pending = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const t = list[i];
      if (t.pct > peak) {
        // 读数是这次请求开始时的快照，反映的是它之前那些调用的消耗，所以只分给 pending，
        // 这次调用自己留到下一轮。
        const step = t.pct - peak;
        peak = t.pct;
        const weight = pending.reduce((a, p) => a + p.cost, 0);
        for (const p of pending) {
          const share = weight > 0 ? (step * p.cost) / weight : step / pending.length;
          result.set(p.convId, result.get(p.convId) + share);
        }
        pending = [];
      }
      pending.push(t);
    }
  }
  return result;
}

/** session / conversation 的数字从 turn 分片重新派生，保证单一事实源。 */
async function deriveTotalsFromTurns(cache) {
  const convTotals = new Map();
  const convModels = new Map();
  const sessionModels = new Map();
  const quotaTurns = [];

  for (const session of Object.values(cache.sessions)) {
    Object.assign(session, ZERO_TOTALS);
    session.estimatedPricing = false;
    sessionModels.set(session.sessionId, new Set());
  }

  for (const sessionId of Object.keys(cache.sessions)) {
    const own = cache.sessions[sessionId];
    const turns = await readTurnsShard(sessionId);
    // 并入根会话的子 agent：用量记到根会话、派出它的那条提问上，自己保持归零。
    const attached = own.attachedTo && cache.sessions[own.attachedTo.sessionId] ? own.attachedTo : null;
    const session = attached ? cache.sessions[attached.sessionId] : own;

    for (const t of turns) {
      accumulate(session, t);
      sessionModels.get(session.sessionId).add(t.model);
      if (t.pricingEstimated) session.estimatedPricing = true;

      const convId = attached ? attached.conversationId : t.conversationId;
      if (t.quotaPct != null) quotaTurns.push({ convId, ts: t.timestamp, pct: t.quotaPct, reset: t.quotaReset, cost: t.cost });
      let ct = convTotals.get(convId);
      if (!ct) {
        ct = Object.assign({}, ZERO_TOTALS);
        convTotals.set(convId, ct);
        convModels.set(convId, new Set());
      }
      accumulate(ct, t);
      convModels.get(convId).add(t.model);
    }
  }

  const quotaByConv = conversationQuotaUsage(quotaTurns);

  for (const [sessionId, session] of Object.entries(cache.sessions)) {
    session.models = Array.from(sessionModels.get(sessionId));
    if (!session.turnCount && !session.attachedTo) delete cache.sessions[sessionId];
  }

  /**
   * session_index.jsonl 里没有这个会话（比如子 agent 日志、被清理掉的旧会话）时，
   * 退而求其次：拿这个会话里最早一条有真实用量、有真实文字的对话当名字，好歹比
   * 一直显示"未命名会话"有用，和 Claude Code 侧遇不到 aiTitle 时同样没有更好办法对称。
   */
  const earliestPromptBySession = new Map();
  for (const [cid, conv] of Object.entries(cache.conversations)) {
    if (conv.kind === INTERNAL_CHECK_KIND || !conv.prompt) continue;
    const totals = convTotals.get(cid);
    if (!totals || totals.totalTokens <= 0) continue;
    const prev = earliestPromptBySession.get(conv.sessionId);
    if (!prev || conv.date < prev.date) earliestPromptBySession.set(conv.sessionId, conv);
  }
  for (const session of Object.values(cache.sessions)) {
    if (session.sessionName) continue;
    const earliest = earliestPromptBySession.get(session.sessionId);
    if (earliest) session.sessionName = earliest.prompt.slice(0, 60);
  }

  for (const [cid, conv] of Object.entries(cache.conversations)) {
    const totals = convTotals.get(cid);
    // 没有产生任何调用用量的记录（纯本地命令，或没等到响应就结束的 turn）不展示。
    if (!totals || totals.totalTokens <= 0) {
      delete cache.conversations[cid];
      continue;
    }
    Object.assign(conv, totals);
    if (quotaByConv.has(cid)) conv.quotaPct = quotaByConv.get(cid);
    else delete conv.quotaPct;
    conv.models = Array.from(convModels.get(cid) || []);
    delete conv.hasRealPrompt;
    const session = cache.sessions[conv.sessionId];
    conv.projectKey = session ? session.projectKey : null;
    conv.projectName = session ? session.projectName : null;
    conv.sessionName = session ? session.sessionName : conv.sessionId;
  }
}

/** 从 turn 级数据逐层向上汇总：project 由 session 汇总，daily 由 conversation 汇总。 */
function aggregate(cache) {
  // 并入根会话的子 agent 用量已经算在根会话里，不再单独计入会话数。
  const sessions = Object.values(cache.sessions).filter((s) => !s.attachedTo);
  const conversations = Object.values(cache.conversations);

  const projects = new Map();
  for (const s of sessions) {
    let p = projects.get(s.projectKey);
    if (!p) {
      p = Object.assign({}, ZERO_TOTALS, {
        projectKey: s.projectKey,
        projectName: s.projectName,
        firstActivity: s.firstActivity,
        lastActivity: s.date,
        sessionCount: 0,
        conversationCount: 0,
        estimatedPricing: false,
        models: new Set(),
      });
      projects.set(s.projectKey, p);
    }
    if (s.firstActivity && (!p.firstActivity || s.firstActivity < p.firstActivity)) {
      p.firstActivity = s.firstActivity;
    }
    if (s.date && (!p.lastActivity || s.date > p.lastActivity)) {
      p.lastActivity = s.date;
      p.projectName = s.projectName;
    }
    p.sessionCount++;
    p.turnCount += s.turnCount || 0;
    for (const f of SUM_FIELDS) p[f] += s[f] || 0;
    p.totalCost = p.cost;
    if (s.estimatedPricing) p.estimatedPricing = true;
    for (const m of s.models) p.models.add(m);
  }

  const daily = new Map();
  for (const conv of conversations) {
    if (conv.projectKey && projects.has(conv.projectKey)) {
      projects.get(conv.projectKey).conversationCount++;
    }
    const day = toLocalDay(conv.date);
    if (!day) continue;
    let d = daily.get(day);
    if (!d) {
      d = Object.assign({}, ZERO_TOTALS, {
        date: day,
        period: day,
        conversationCount: 0,
        models: new Set(),
      });
      daily.set(day, d);
    }
    d.conversationCount++;
    d.turnCount += conv.turnCount || 0;
    for (const f of SUM_FIELDS) d[f] += conv[f] || 0;
    d.totalCost = d.cost;
    for (const m of conv.models) d.models.add(m);
  }

  cache.projects = Array.from(projects.values())
    .map((p) => Object.assign({}, p, { models: Array.from(p.models) }))
    .sort((a, b) => b.totalCost - a.totalCost);

  cache.daily = Array.from(daily.values())
    .map((d) => Object.assign({}, d, { models: Array.from(d.models) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const totals = Object.assign({}, ZERO_TOTALS);
  let estimatedPricing = false;
  for (const s of sessions) {
    totals.turnCount += s.turnCount || 0;
    for (const f of SUM_FIELDS) totals[f] += s[f] || 0;
    if (s.estimatedPricing) estimatedPricing = true;
  }
  cache.summary = Object.assign({}, totals, {
    totalCost: totals.cost,
    activeDays: cache.daily.length,
    projectCount: cache.projects.length,
    sessionCount: sessions.length,
    conversationCount: conversations.length,
    estimatedPricing,
  });
}
