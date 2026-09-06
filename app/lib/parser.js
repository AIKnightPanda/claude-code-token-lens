import { extractTokens, calculateCostBreakdown, getPricing } from './pricing.js';

/**
 * 这个模块只负责解析与聚合，不碰任何具体的 I/O 实现。
 *
 * 真正的读写由外部注入的 io 适配器提供：
 *   - Node（`npm run verify`）  -> ./io-node.js
 *   - 桌面端（Tauri WebView）   -> ./io-tauri.js
 * 两端共用同一份解析逻辑，避免两套代码算出两个数。
 * 别直接 import 本模块，用 ./parser-node.js 或 ./parser-tauri.js。
 */
let io = null;

export function setIO(impl) {
  io = impl;
}

/** Tauri 的命令是以字符串 reject 的，没有 .message，统一在这里兜住。 */
function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};

export const CACHE_VERSION = 3;

/**
 * 去重范围。
 *
 * 'session'（与 ccusage 一致）
 *   去重键 = message.id + requestId + sessionId。
 *   同一次 API 响应在 JSONL 里会被拆成多行（thinking / text / 每个 tool_use
 *   各一行），每行都带着同一份 usage —— 这一档能消掉它。
 *   但 resume/fork 会把历史复制进新文件并改写 sessionId，那部分仍会被算两次。
 *
 * 'global'（默认）
 *   去重键 = message.id + requestId，忽略 sessionId。
 *   连 resume 重放也一并消掉，总额最接近真实账单；代价是被 resume 继承的历史
 *   只算在最先出现的那个 session 名下，后续 session 看起来会「变便宜」。
 *
 * 实测这两档在本机数据上相差约 20%。用 TOKEN_LENS_DEDUP_SCOPE=session 可切换。
 */
export const DEDUP_SCOPE = env.TOKEN_LENS_DEDUP_SCOPE || 'global';

/**
 * 是否把用户提示词的开头存进缓存。
 *
 * 对话列表默认展示提示词，方便辨认「这次花的钱是干什么的」。但这意味着
 * 提示词原文会以明文落到 data/usage_cache.json。设为 'false' 可只统计用量、
 * 不留存任何提示词内容。
 */
export const STORE_PROMPTS = env.TOKEN_LENS_STORE_PROMPTS !== 'false';

/**
 * 每条提示词最多保留的字符数。
 *
 * 实测真实提问的长度 P50=144、P95=973、最长 7090 字，10000 字能 100% 完整保留，
 * 相比 2000 字只多占约 0.03MB。保留上限是为了兜底——万一有人把整个文件粘进提问，
 * 不至于让缓存和接口响应被一条记录撑爆。
 */
const PROMPT_MAX_CHARS = Number(env.TOKEN_LENS_PROMPT_MAX_CHARS) || 10000;

/** 日志根目录。只有 Node 侧用得上（verify 脚本要自己扫一遍对账）。 */
export function getProjectsDir() {
  return io.projectsDir();
}

/** 本地时区的 YYYY-MM-DD。日志里的 timestamp 是 UTC，直接切字符串会错位一天。 */
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
    version: CACHE_VERSION,
    generatedAt: null,
    dedupScope: DEDUP_SCOPE,
    storePrompts: STORE_PROMPTS,
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
  // 首次启动没有缓存文件，这是正常路径，不是错误。
  if (raw == null) return { cache: emptyCache(), rebuildReason: 'no-cache' };
  try {
    const parsed = JSON.parse(raw);
    // 结构或去重口径变了就整体重建，避免新旧口径的数据混在一起产生对不上的总额。
    if (
      parsed.version !== CACHE_VERSION
      || parsed.dedupScope !== DEDUP_SCOPE
      || parsed.storePrompts !== STORE_PROMPTS
    ) {
      return { cache: emptyCache(), rebuildReason: 'cache-version-or-scope-changed' };
    }
    return { cache: Object.assign(emptyCache(), parsed), rebuildReason: null };
  } catch (err) {
    // 缓存损坏时重建，但把原因带出去，而不是静默清空。
    return { cache: emptyCache(), rebuildReason: 'unreadable-cache: ' + errText(err) };
  }
}

async function writeCache(cache) {
  // 不带缩进：缩进在这个体量下白占约 20% 体积，而且没人会去读它。
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

/**
 * 取一条对话的 turn 明细。
 *
 * turn 数据量随使用时长线性增长（实测 34 天已有 7600+ 条），所以不进主看板数据，
 * 只在下钻时按需读。conversationId 形如 "<sessionId>:<uuid>"，能直接反解出所在
 * 分片，不必扫描全部分片。
 */
export async function getTurnsForConversation(conversationId) {
  if (!conversationId) return [];
  const sessionId = String(conversationId).split(':')[0];
  const { cache } = await readCache();
  if (!cache.sessions[sessionId]) return [];
  const turns = await readTurnsShard(sessionId);
  return turns.filter((t) => t.conversationId === conversationId);
}

async function writeTurnsShard(sessionId, turns) {
  if (!turns.length) {
    await io.removeTurns(sessionId);
    return;
  }
  await io.writeTurns(sessionId, JSON.stringify(turns));
}

/**
 * Claude Code 会把一批**系统注入的内容**也写成 `type: "user"`。
 *
 * 它们不是用户说的话，但长度可观、后面又紧跟着昂贵的 assistant 轮次，
 * 如果当成用户提问，对话列表里就会冒出一条「我没说过却花了很多钱」的记录。
 * 实测这类条目占全部非工具结果 user 条目的约四成。
 *
 * 已知的几类：
 *   isMeta: true            技能正文注入、<local-command-caveat> 等
 *   isCompactSummary: true  上下文压缩后自动生成的摘要
 *   <local-command-stdout>  斜杠命令的本地输出
 *   [Request interrupted…]  用户打断的占位记录
 *
 * 斜杠命令本身（<command-name> / <command-message>）保留 —— 那确实是用户的操作，
 * 只是显示时会被 extractPromptText 转成可读形式。
 */
const SYSTEM_TEXT_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<command-stdout>',
  // 后台任务启动提醒会以用户回合投递，甚至被标成 origin.kind='human'，
  // 只能按正文前缀识别。真实提问不会以这个标签开头。
  '<system-reminder>',
  '[Request interrupted',
];

/**
 * 后台任务/监视器完成时，Claude Code 会把一条 `<task-notification>` 投递进会话，
 * 唤醒 Claude 继续干活。它不是用户打字发的，但确实会引发真实的 API 调用，
 * 所以要保留并单独标记，让人知道这笔开销的来源。
 */
function isTaskNotificationEntry(entry, text) {
  const origin = entry.origin;
  if (origin && typeof origin === 'object' && origin.kind === 'task-notification') return true;
  // 旧版日志没有 origin 字段，退回按正文判断
  return text.trimStart().startsWith('<task-notification>');
}

/** 从任务通知里取出可读的 summary，避免在界面上堆一坨 XML。 */
function taskNotificationSummary(text) {
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/);
  const event = text.match(/<event>([\s\S]*?)<\/event>/);
  const parts = [];
  if (summary) parts.push(summary[1].trim());
  if (event) parts.push(event[1].trim());
  if (parts.length) return parts.join(' — ');
  // <system-reminder> 这类没有结构化字段，去掉标签后取正文。
  return text.replace(/<\/?[a-z-]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 斜杠命令（/compact、/init、/prd-as-code…）是用户的真实操作，要单独成条展示。 */
function isSlashCommandEntry(text) {
  const head = text.trimStart();
  return head.startsWith('<command-name>') || head.startsWith('<command-message>');
}

function isSystemInjectedUserEntry(entry, text) {
  if (entry.isMeta === true) return true;
  if (entry.isCompactSummary === true) return true;
  // 后台任务/监视器的唤醒通知也算系统注入：它归根结底是用户先前某次提问
  // 发起的工作的延续，不该在对话这一层单独占一行。它触发的开销会记到上一条
  // 真实提问名下，具体是哪个任务唤醒的则标在 turn 上，下钻可见。
  if (isTaskNotificationEntry(entry, text)) return true;
  const head = text.trimStart();
  return SYSTEM_TEXT_PREFIXES.some((p) => head.startsWith(p));
}

/** 判断一条 user 记录是不是真实用户输入（排除工具结果回填与系统注入内容）。 */
function isRealUserPrompt(entry) {
  if (entry.type !== 'user' && entry.role !== 'user') return false;
  const content = entry.message && entry.message.content;
  if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) return false;
  return true;
}

function rawPromptText(entry) {
  const msg = entry.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.map((m) => (m && m.text) || '').join(' ');
  if (msg && typeof msg.content === 'string') return msg.content;
  if (msg && Array.isArray(msg.content)) {
    return msg.content.map((m) => (typeof m === 'string' ? m : (m && m.text) || '')).join(' ');
  }
  return '';
}

/**
 * 斜杠命令在日志里是一串 XML，直接展示很难读。
 * `<command-name>/compact</command-name>` 这样的记录转成 `/compact`，
 * 带参数的再把参数接上。
 */
function extractPromptText(entry) {
  const raw = rawPromptText(entry);
  const name = raw.match(/<command-(?:name|message)>([\s\S]*?)<\/command-(?:name|message)>/);
  if (!name) return raw;
  const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const label = name[1].trim();
  // 参数位里可能被塞进系统提醒（例如后台任务启动通知），那不是用户打的字，
  // 展示出来会让人误以为自己写过这段话。剥掉后若为空，说明这次命令没带参数。
  const argText = args
    ? args[1].replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    : '';
  const slash = label.startsWith('/') ? label : '/' + label;
  return argText ? slash + ' ' + argText : slash;
}

function dedupKey(msgId, requestId, sessionId) {
  const base = msgId + ' ' + (requestId || '');
  return DEDUP_SCOPE === 'global' ? base : base + ' ' + sessionId;
}

/**
 * 取路径最后一段作为项目显示名。
 *
 * 必须同时认 `/` 和 `\`：日志里的 cwd 由 Claude Code 按运行平台写入，
 * 在 Windows 上是 `C:\Users\me\proj`，只按 `/` 切会把整条路径当成项目名。
 */
function baseName(p, fallback) {
  const segments = String(p || '').split(/[/\\]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : fallback;
}

/**
 * conversation 的 id 必须带 sessionId 前缀。
 *
 * resume/fork 复制转录时会保留用户提示的 uuid，如果直接拿 uuid 当 id，
 * 新 session 里那条空的 conversation 会覆盖原 session 已经填好的同 id 记录，
 * 导致它名下的 turn 变成孤儿（实测漏掉 3.3 亿 token）。
 */
function conversationId(sessionId, uuid, seq) {
  return sessionId + ':' + (uuid || 'seq' + seq);
}

/** kind: 'prompt' 用户提问 | 'command' 斜杠命令 | 'notification' 后台任务通知 */
function newConversation(id, sessionId, timestamp, prompt, kind = 'prompt') {
  return {
    id,
    sessionId,
    date: timestamp,
    prompt: STORE_PROMPTS ? String(prompt || '').slice(0, PROMPT_MAX_CHARS) : '',
    kind,
  };
}

/**
 * 流式解析单个 JSONL 文件的一段区间。
 *
 * 逐行读取，不把整个文件读进内存：实测单个 session 文件可达 68MB，
 * readFileSync + split('\n') 会让 RSS 冲到约 1GB。
 */
async function parseFileRange(filePath, startOffset, ctx) {
  for await (const line of io.readLines(filePath, startOffset)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // 增量续读时尾行可能被截断；计数，不静默丢弃。
      ctx.stats.linesSkipped++;
      continue;
    }
    ctx.stats.linesParsed++;

    if (entry.cwd && !ctx.cwd) ctx.cwd = entry.cwd;
    if (entry.timestamp) {
      ctx.lastActivity = entry.timestamp;
      if (!ctx.firstActivity) ctx.firstActivity = entry.timestamp;
    }
    if (entry.customTitle) ctx.customTitle = entry.customTitle;
    if (entry.aiTitle) ctx.aiTitle = entry.aiTitle;

    if (isRealUserPrompt(entry)) {
      const raw = rawPromptText(entry);
      const text = extractPromptText(entry);
      // 系统注入的内容不新开一段对话，后续的 assistant 轮次仍归到上一条真实提问下 ——
      // 那些开销本来就是这次提问引发的（技能加载、上下文压缩都发生在回答过程中）。
      if (isSystemInjectedUserEntry(entry, raw)) {
        ctx.stats.systemPromptsSkipped++;
        // 记下唤醒来源，随后的 turn 会带上它，方便在明细里回答
        // 「这几轮是谁触发的」。下一条真实提问会把它清掉。
        const head = raw.trimStart();
        if (isTaskNotificationEntry(entry, raw) || head.startsWith('<system-reminder>')) {
          ctx.pendingTrigger = taskNotificationSummary(raw).slice(0, 160);
          ctx.stats.taskNotifications++;
        }
        continue;
      }
      ctx.pendingTrigger = null;
      // 确定性 ID：缺 uuid 时退回「会话 + 序号」。不能用随机数，
      // 否则每次刷新 ID 都变，下钻链接失效、去重也失效。
      const id = conversationId(ctx.sessionId, entry.uuid, ctx.convSeq);
      ctx.convSeq++;
      ctx.currentConvId = id;
      const isCmd = isSlashCommandEntry(raw);
      const conv = newConversation(id, ctx.sessionId, entry.timestamp, text, isCmd ? 'command' : 'prompt');
      // /compact 之前刚记录过一次压缩边界，把规模挂到这条命令上。
      if (isCmd && ctx.pendingCompaction && text.startsWith('/compact')) {
        conv.compaction = ctx.pendingCompaction;
        ctx.pendingCompaction = null;
      }
      ctx.conversations.set(id, conv);
      continue;
    }

    // 上下文压缩的规模记在 system/compact_boundary 里。
    // 压缩本身会调用一次 Claude，但 Claude Code **没有**把那次调用的 usage 写进日志，
    // 所以这里只能记录「压缩掉了多少上下文」，成本无法计入总额（ccusage 同样如此）。
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const cm = entry.compactMetadata || {};
      ctx.pendingCompaction = {
        preTokens: cm.preTokens || 0,
        postTokens: cm.postTokens || 0,
        trigger: cm.trigger || null,
      };
      ctx.stats.compactions++;
      ctx.stats.compactedTokens += cm.preTokens || 0;
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const usage = entry.message && entry.message.usage;
    if (!usage) continue;

    const rawModel = entry.message.model || 'claude-sonnet-5';
    // `<synthetic>` 是 Claude Code 本地生成的占位消息（"API Error: ..."、
    // "No response requested."），实测全部为 0 token —— 不是真实 API 调用，
    // 计入只会污染模型标签和交互次数。
    if (rawModel === '<synthetic>') {
      ctx.stats.syntheticSkipped++;
      continue;
    }

    const msgId = entry.message.id || null;
    const requestId = entry.requestId || null;
    const entrySessionId = entry.sessionId || ctx.sessionId;
    const tokens = extractTokens(usage);

    // 没有 message.id 就无法判重，只能保留（实测本机日志中为 0 条）。
    const key = msgId ? dedupKey(msgId, requestId, entrySessionId) : null;
    if (key) {
      const existing = ctx.seen.get(key);
      if (existing) {
        ctx.stats.duplicatesDropped++;
        // 记下「本会话有多少次调用是从别的会话继承来的」。
        // resume/fork 会把历史整段复制过来，某些会话可能 100% 由继承内容组成；
        // 如果只是把它们丢掉，看板上会凭空少一行，看起来像数据丢失。
        if (existing.sessionId !== ctx.sessionId) {
          ctx.inheritedTurns++;
          ctx.inheritedFrom.add(existing.sessionId);
        }
        // 同键冲突保留 token 更大的那条：复制的转录里存在 usage 全 0 的占位副本，
        // 「后写入者胜」会把真实用量覆盖掉。
        if (tokens.totalTokens <= existing.totalTokens) continue;
        ctx.stats.duplicatesUpgraded++;
        const idx = ctx.turns.indexOf(existing);
        if (idx !== -1) ctx.turns.splice(idx, 1);
        // 落败者可能属于另一个 session 的分片（global 去重时会跨 session 比较），
        // 标记下来，在最终汇总阶段统一从分片里剔除。
        ctx.superseded.add(existing.sessionId + '|' + existing.id);
      }
    }

    if (!ctx.currentConvId) {
      const id = conversationId(ctx.sessionId, null, ctx.convSeq);
      ctx.convSeq++;
      ctx.currentConvId = id;
      ctx.conversations.set(id, newConversation(id, ctx.sessionId, entry.timestamp, '(后台任务 / 会话起始)'));
    }

    const pricing = getPricing(rawModel);
    const breakdown = calculateCostBreakdown(tokens, rawModel, { speed: usage.speed });
    const turn = {
      id: entry.uuid || ctx.sessionId + ':turn:' + ctx.turnSeq,
      dedupKey: key,
      conversationId: ctx.currentConvId,
      sessionId: ctx.sessionId,
      timestamp: entry.timestamp,
      model: rawModel,
      pricingEstimated: pricing.estimated,
      speed: usage.speed || null,
      trigger: ctx.pendingTrigger || null,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      cacheWrite1h: tokens.cacheWrite1h,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheTokens: tokens.cacheTokens,
      totalTokens: tokens.totalTokens,
      webSearchRequests: tokens.webSearchRequests,
      cost: breakdown.total,
      costInput: breakdown.input,
      costOutput: breakdown.output,
      costCacheWrite: breakdown.cacheWrite,
      costCacheRead: breakdown.cacheRead,
      costServerTools: breakdown.serverTools,
    };
    ctx.turnSeq++;
    ctx.turns.push(turn);
    if (key) ctx.seen.set(key, turn);
  }
}

/**
 * 增量刷新。
 *
 * 每个文件记录 {mtimeMs, size, offset}：
 *  - mtime 和 size 都没变     -> 完全跳过
 *  - size 变大且 mtime 变新   -> 从 offset 续读，只解析新增字节
 *  - size 变小（被截断/重写） -> 整文件重解析
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

  // 按路径排序，让解析顺序与目录遍历顺序无关。
  // global 去重下「谁先出现谁记账」，顺序一变，被 resume 继承的历史就会挂到
  // 另一个 session 名下 —— 总额不变，但每个 session 的数字会跟着抖。
  const files = (await io.listLogFiles()).sort(
    (a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)
  );
  const stats = {
    filesScanned: files.length,
    filesParsed: 0,
    linesParsed: 0,
    linesSkipped: 0,
    duplicatesDropped: 0,
    duplicatesUpgraded: 0,
    syntheticSkipped: 0,
    systemPromptsSkipped: 0,
    compactions: 0,
    taskNotifications: 0,
    compactedTokens: 0,
    filesRemoved: 0,
    rebuildReason,
  };

  // 已删除的日志文件要连同它的数据一起清掉，否则会永远留在看板上。
  const alive = new Set(files.map((f) => f.filePath));
  for (const registered of Object.keys(cache.fileRegistry)) {
    if (alive.has(registered)) continue;
    const sessionId = cache.fileRegistry[registered].sessionId;
    delete cache.fileRegistry[registered];
    delete cache.sessions[sessionId];
    for (const [cid, conv] of Object.entries(cache.conversations)) {
      if (conv.sessionId === sessionId) delete cache.conversations[cid];
    }
    await io.removeTurns(sessionId);
    stats.filesRemoved++;
  }

  // global 模式下去重要跨 session 生效，需要一份全局已见键的归属表。
  // 从现存 turn 分片重建，这样增量刷新也能正确判重。
  const seenOwner = new Map();
  if (DEDUP_SCOPE === 'global') {
    for (const sessionId of Object.keys(cache.sessions)) {
      for (const t of await readTurnsShard(sessionId)) {
        if (t.dedupKey) seenOwner.set(t.dedupKey, t);
      }
    }
  }

  // 同键冲突中落败的 turn（可能属于其它 session 的分片），在汇总阶段统一剔除。
  const superseded = new Set();

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

    // 整文件重解析时，先把这个 session 的旧数据从全局去重表里摘掉，
    // 否则重解析出来的行会被自己的旧记录判成重复。
    if (!resume) {
      for (const t of await readTurnsShard(sessionId)) {
        if (t.dedupKey && seenOwner.get(t.dedupKey) === t) seenOwner.delete(t.dedupKey);
        else if (t.dedupKey && seenOwner.has(t.dedupKey) && seenOwner.get(t.dedupKey).sessionId === sessionId) {
          seenOwner.delete(t.dedupKey);
        }
      }
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
      firstActivity: prev ? prev.firstActivity : null,
      lastActivity: prev ? prev.date : null,
      customTitle: prev ? prev.customTitle : null,
      aiTitle: prev ? prev.aiTitle : null,
      currentConvId: reg && resume ? reg.lastConversationId : null,
      convSeq: reg && resume ? reg.convSeq || 0 : 0,
      turnSeq: reg && resume ? reg.turnSeq || 0 : 0,
      pendingCompaction: null,
      pendingTrigger: null,
      inheritedTurns: prev ? prev.inheritedTurns || 0 : 0,
      inheritedFrom: new Set(prev ? prev.inheritedFrom || [] : []),
      conversations,
      turns: existingTurns.slice(),
      seen: DEDUP_SCOPE === 'global' ? seenOwner : new Map(),
      superseded,
      stats,
    };
    if (DEDUP_SCOPE !== 'global') {
      for (const t of existingTurns) if (t.dedupKey) ctx.seen.set(t.dedupKey, t);
    }

    try {
      await parseFileRange(file.filePath, startOffset, ctx);
    } catch (err) {
      stats.linesSkipped++;
      // 单个文件读失败不应该拖垮整次刷新，但要留痕。
      stats.lastError = file.filePath + ': ' + errText(err);
      continue;
    }
    stats.filesParsed++;

    for (const [cid, conv] of ctx.conversations) cache.conversations[cid] = conv;
    await writeTurnsShard(sessionId, ctx.turns);

    // 项目身份用 cwd 全路径，不用目录名：不同路径下的同名目录必须区分开。
    const projectKey = ctx.cwd || file.projectPath;
    cache.sessions[sessionId] = {
      sessionId,
      // customTitle/aiTitle 必须落盘：增量刷新只解析新追加的字节，
      // 如果那几行里没有 title 记录，就得靠这里恢复，否则标题会时有时无。
      customTitle: ctx.customTitle || null,
      aiTitle: ctx.aiTitle || null,
      sessionName: ctx.customTitle || ctx.aiTitle || null,
      projectKey,
      projectName: baseName(projectKey, file.folderName),
      cwd: ctx.cwd || null,
      firstActivity: ctx.firstActivity,
      date: ctx.lastActivity,
      inheritedTurns: ctx.inheritedTurns,
      inheritedFrom: Array.from(ctx.inheritedFrom),
    };

    cache.fileRegistry[file.filePath] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      offset: file.size,
      sessionId,
      lastConversationId: ctx.currentConvId,
      convSeq: ctx.convSeq,
      turnSeq: ctx.turnSeq,
    };
  }

  await deriveTotalsFromTurns(cache, superseded);
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
  cacheWrite1h: 0,
  cacheReadTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheWrite: 0,
  costCacheRead: 0,
  costServerTools: 0,
  webSearchRequests: 0,
  turnCount: 0,
};

/** 需要逐层累加的数值字段。 */
const SUM_FIELDS = Object.keys(ZERO_TOTALS).filter((k) => k !== 'turnCount');

function accumulate(target, turn) {
  for (const f of SUM_FIELDS) target[f] += turn[f] || 0;
  target.turnCount += 1;
}

/**
 * 把 session / conversation 的所有数字**从 turn 分片重新派生**，而不是在解析
 * 过程中手工累加。
 *
 * 这样「单一事实源」是结构上成立的：只要 turn 是对的，上层就不可能对不上。
 * 旧实现里 session、conversation、turn 三条链路各自累加、去重时机还不同，
 * 于是同一屏能出现三个互相矛盾的总额。
 */
async function deriveTotalsFromTurns(cache, superseded) {
  const convTotals = new Map();
  const convModels = new Map();

  for (const sessionId of Object.keys(cache.sessions)) {
    const turns = await readTurnsShard(sessionId);
    // 剔除同键冲突中落败的 turn（可能是在别的文件里被更完整的副本取代的）。
    const kept = superseded.size
      ? turns.filter((t) => !superseded.has(sessionId + '|' + t.id))
      : turns;
    if (kept.length !== turns.length) await writeTurnsShard(sessionId, kept);

    const session = cache.sessions[sessionId];
    Object.assign(session, ZERO_TOTALS);
    const models = new Set();
    session.estimatedPricing = false;

    for (const t of kept) {
      accumulate(session, t);
      models.add(t.model);
      if (t.pricingEstimated) session.estimatedPricing = true;

      let ct = convTotals.get(t.conversationId);
      if (!ct) {
        ct = Object.assign({}, ZERO_TOTALS);
        convTotals.set(t.conversationId, ct);
        convModels.set(t.conversationId, new Set());
      }
      accumulate(ct, t);
      convModels.get(t.conversationId).add(t.model);
    }
    session.models = Array.from(models);
    // 全部内容都继承自别的会话（resume/fork 重放）时保留该行并标注，
    // 数字为 0 但不凭空消失；真正的空会话（只有 synthetic 或没有调用）才删除。
    session.replayOnly = kept.length === 0 && session.inheritedTurns > 0;
    if (!kept.length) {
      await writeTurnsShard(sessionId, []);
      if (!session.replayOnly) delete cache.sessions[sessionId];
    }
  }

  for (const [cid, conv] of Object.entries(cache.conversations)) {
    const totals = convTotals.get(cid);
    const spent = totals && totals.totalTokens > 0;
    // 没有产生任何开销的记录不展示 —— /model、/context 这类纯本地命令留在列表里
    // 只会是一堆 $0.00 的噪音。唯一的例外是 /compact：它确实花了钱，
    // 只是 Claude Code 没把用量写进日志，那条压缩规模值得留下。
    if (!spent && !conv.compaction) {
      delete cache.conversations[cid];
      continue;
    }
    Object.assign(conv, totals || Object.assign({}, ZERO_TOTALS));
    conv.models = Array.from(convModels.get(cid) || []);
    const session = cache.sessions[conv.sessionId];
    conv.projectKey = session ? session.projectKey : null;
    conv.projectName = session ? session.projectName : null;
    conv.sessionName = session ? session.sessionName : conv.sessionId;
  }
}

/**
 * 从 turn 级去重后的数据逐层向上汇总。
 *
 * 单一事实源：session / conversation 的数字都来自同一批已去重的 turn，
 * project 由 session 汇总、daily 由 conversation 汇总，
 * 所以各层总额必然自洽（旧实现里三条链路各算各的，同屏数字对不上）。
 */
function aggregate(cache) {
  const sessions = Object.values(cache.sessions);
  const conversations = Object.values(cache.conversations);

  const projects = new Map();
  for (const s of sessions) {
    let p = projects.get(s.projectKey);
    if (!p) {
      // 用 SUM_FIELDS 铺开而不是逐字段手抄：手抄过一次就会漏，
      // 成本拆分字段最初就是这样没能传到 project / daily 层的。
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
    // 表格列名沿用 totalCost，与 session 的 cost 保持同一个数。
    p.totalCost = p.cost;
    if (s.estimatedPricing) p.estimatedPricing = true;
    for (const m of s.models) p.models.add(m);
  }

  const daily = new Map();
  for (const conv of conversations) {
    if (conv.projectKey && projects.has(conv.projectKey)) {
      projects.get(conv.projectKey).conversationCount++;
    }
    // 按本地时区分桶：日志时间戳是 UTC，直接切字符串会让凌晨的活动算到前一天。
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

  // 汇总卡片直接用 session 层的合计，和 Projects 页同源，保证同屏数字一致。
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
    dedupScope: DEDUP_SCOPE,
  });
}
