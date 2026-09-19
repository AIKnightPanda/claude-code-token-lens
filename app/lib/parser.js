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

/**
 * v4：日志被删后统计改为保留（sourceDeleted），新增子 agent 日志。旧缓存里没有 promptIndex，
 *     子 agent 的开销挂不回父对话，所以要整体重建一次。
 * v5：去掉 v4 的「移除墓碑」。删除只针对原始日志已不在的记录，日志还在的内容一律以日志为准；
 *     重建一次，让 v4 期间被墓碑挡掉、但日志仍在的内容重新出现。
 * v6：解析顺序从「按路径」改为「按文件里第一条时间戳」，分叉、编辑重发复制出来的历史记回原会话；
 *     注册表新增 startedAt。重建一次，纠正旧缓存里挂错会话的共享历史。
 */
export const CACHE_VERSION = 6;

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

/**
 * 对话 id 里的 uuid 部分。resume 复制出去的副本共用同一个 uuid；缺 uuid 时退回的
 * `seqN` 只在本会话内唯一，这时返回完整 id。
 */
function conversationUuid(cid) {
  const id = String(cid);
  const uuid = id.slice(id.indexOf(':') + 1);
  return !uuid || uuid.startsWith('seq') ? id : uuid;
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
    // sessionId -> { promptId -> conversationId }，子 agent 靠它找到派出自己的那次提问
    promptIndex: {},
    projects: [],
    daily: [],
    summary: {},
    stats: {},
  };
}

/**
 * 从旧缓存里挑出**没法从日志重算**的部分，其余一律丢弃重建：原始日志已删除、但统计
 * 保留下来的会话，连同它的对话与 promptIndex（分片不在缓存文件里，原地不动）。
 */
function carryOverArchive(old) {
  const cache = emptyCache();
  if (!old || typeof old !== 'object') return cache;
  for (const [sid, session] of Object.entries(old.sessions || {})) {
    if (!session || !session.sourceDeleted) continue;
    cache.sessions[sid] = session;
    if (old.promptIndex && old.promptIndex[sid]) cache.promptIndex[sid] = old.promptIndex[sid];
  }
  for (const [cid, conv] of Object.entries(old.conversations || {})) {
    if (conv && cache.sessions[conv.sessionId]) cache.conversations[cid] = conv;
  }
  return cache;
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
      return { cache: carryOverArchive(parsed), rebuildReason: 'cache-version-or-scope-changed' };
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
  const { cache } = await readCache();
  const conv = cache.conversations[conversationId];
  // 被 resume 打断的提问，两半 turn 分别落在两个会话的分片里（见
  // mergeReplayedConversations），只读 id 自带的那个分片会少掉一半明细。
  const shards = (conv && conv.shards) || [String(conversationId).split(':')[0]];

  const out = [];
  for (const sessionId of shards) {
    if (!cache.sessions[sessionId]) continue;
    for (const t of await readTurnsShard(sessionId)) {
      if (t.conversationId === conversationId) out.push(t);
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return out;
}

/** 这条记录的内容是否还有一部分存在于仍在的日志里（见 removeFromStats）。 */
function overlapsLiveLogs(cache, sessionId, convIds) {
  const live = (sid) => !!cache.sessions[sid] && !cache.sessions[sid].sourceDeleted;
  // 主日志删了，但它的子 agent 日志还在
  if (Object.values(cache.fileRegistry).some((r) => r.sessionId === sessionId)) return true;
  // 它的历史被 resume 复制进了仍在的会话
  if (Object.values(cache.sessions).some((s) => live(s.sessionId) && (s.inheritedFrom || []).includes(sessionId))) {
    return true;
  }
  // 要删的对话横跨到了仍在的会话（被 resume 打断的提问，两半 turn 分在两处）
  for (const cid of convIds) {
    if ((cache.conversations[cid].shards || []).some(live)) return true;
  }
  return false;
}

/**
 * 删除一条「原始日志已删除」的缓存记录：整个会话，或其中一条对话。
 *
 * 只允许删日志已经不在的记录。日志还在的内容一律以日志为准，删了下次同步也会回来，
 * 所以界面上根本不给这个按钮。删除会把提示词原文和 turn 明细一起从磁盘抹掉，不留痕迹。
 *
 * 通常一次增量刷新就够了。例外是这条记录的内容**还存在于某个仍在的日志里**，最常见的是
 * resume：Claude Code 把旧会话的整段历史复制进新会话的日志，去重后这些调用只记在旧会话
 * 名下。旧会话的记录删掉后，按「日志在就算」它们应改记到新会话，可新会话的日志没变、
 * 增量刷新不会重读它 —— 这时做一次全量重建。
 */
export async function removeFromStats({ sessionId = null, conversationId = null } = {}) {
  const { cache, rebuildReason } = await readCache();
  if (rebuildReason) throw new Error('缓存尚未就绪，请先刷新: ' + rebuildReason);

  let owner;
  const convIds = new Set();
  if (sessionId) {
    owner = cache.sessions[sessionId];
    if (!owner) throw new Error('会话不存在: ' + sessionId);
    for (const [cid, conv] of Object.entries(cache.conversations)) {
      if (conv.sessionId === sessionId) convIds.add(cid);
    }
  } else if (conversationId) {
    const conv = cache.conversations[conversationId];
    if (!conv) throw new Error('对话不存在: ' + conversationId);
    owner = cache.sessions[conv.sessionId];
    convIds.add(conversationId);
  } else {
    throw new Error('removeFromStats 需要 sessionId 或 conversationId');
  }
  if (!owner || !owner.sourceDeleted) {
    throw new Error('原始日志仍在，不能删除：下次同步它会重新出现');
  }
  const needsRebuild = overlapsLiveLogs(cache, owner.sessionId, convIds);

  // 这些对话的 turn 可能横跨多个分片。日志已删除的分片没法重算，必须在这里删干净；
  // 日志还在的分片即便这里删了，也会在紧接着的全量重建里按日志重读回来。
  const shardIds = new Set(sessionId ? [sessionId] : []);
  for (const cid of convIds) {
    const conv = cache.conversations[cid];
    for (const sid of conv.shards || [conv.sessionId]) shardIds.add(sid);
  }
  for (const sid of shardIds) {
    if (sid === sessionId) {
      await io.removeTurns(sid);
      continue;
    }
    const turns = await readTurnsShard(sid);
    const left = turns.filter((t) => !convIds.has(t.conversationId));
    if (left.length !== turns.length) await writeTurnsShard(sid, left);
  }
  for (const cid of convIds) delete cache.conversations[cid];
  if (sessionId) {
    delete cache.sessions[sessionId];
    delete cache.promptIndex[sessionId];
  }
  await writeCache(cache);

  const next = await refreshUsage({ force: needsRebuild });
  next.stats.deletionRebuild = needsRebuild;
  return next;
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

/** 只读文件头时每块的大小：够装下开头几行元数据，不必像正常解析那样一次搬 4MB。 */
const HEAD_CHUNK_BYTES = 64 * 1024;

/**
 * 文件里第一条带时间戳的记录的时间，决定解析顺序（原因见 refreshUsage）。
 * 找到就停，通常只读第一块；读不了返回 null，排到最后，解析阶段会再记错误。
 */
async function readStartedAt(filePath) {
  try {
    for await (const line of io.readLines(filePath, 0, HEAD_CHUNK_BYTES)) {
      if (!line.includes('"timestamp"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp) return entry.timestamp;
      } catch {
        /* 半截行，接着往下找 */
      }
    }
  } catch {
    /* 同上：交给解析阶段报错 */
  }
  return null;
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

    if (ctx.subagent) {
      // 子 agent 的日志里每条 user 记录都带着父会话那次提问的 promptId，据此挂回父对话。
      if (!ctx.currentConvId && entry.promptId && ctx.promptIndex[entry.promptId]) {
        ctx.currentConvId = ctx.promptIndex[entry.promptId];
      }
    } else if (entry.type === 'user' && entry.promptId && ctx.currentConvId && !ctx.promptIndex[entry.promptId]) {
      // 工具结果、后台唤醒这些 user 记录也带 promptId，一并记下它们落在哪条对话里。
      ctx.promptIndex[entry.promptId] = ctx.currentConvId;
    }

    if (isRealUserPrompt(entry)) {
      if (ctx.subagent) {
        // 子 agent 日志里的 user 消息是父会话派给它的任务说明，不是你打的字，不新开对话；
        // 第一条顺手拿来当这个子 agent 的说明。
        if (!ctx.agentLabel && STORE_PROMPTS) {
          ctx.agentLabel = extractPromptText(entry).replace(/\s+/g, ' ').trim().slice(0, 160) || null;
        }
        continue;
      }
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
      if (entry.promptId) ctx.promptIndex[entry.promptId] = id;
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
    const turnId = entry.uuid || ctx.sessionId + ':turn:' + ctx.turnSeq;
    if (ctx.subagent && !ctx.currentConvId) ctx.currentConvId = subagentFallbackConv(ctx, entry.timestamp);

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
      id: turnId,
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
    if (ctx.subagent) {
      turn.subagent = ctx.subagent;
      turn.agent = ctx.agentLabel;
    }
    ctx.turnSeq++;
    ctx.turns.push(turn);
    if (key) ctx.seen.set(key, turn);
  }
}

/**
 * 子 agent 找不到 promptId 对应的对话时（例如父日志被截断过），退而挂到它开始之前
 * 父会话里最近的一条对话上；连这个都没有，才单独建一条。
 */
function subagentFallbackConv(ctx, timestamp) {
  let best = null;
  for (const conv of ctx.conversations.values()) {
    if (!conv.date || (timestamp && conv.date > timestamp)) continue;
    if (!best || conv.date > best.date) best = conv;
  }
  if (best) return best.id;
  const id = ctx.sessionId + ':' + ctx.subagent;
  if (!ctx.conversations.has(id)) {
    ctx.conversations.set(id, newConversation(id, ctx.sessionId, timestamp, '(子 agent)'));
  }
  return id;
}

/**
 * 增量刷新。
 *
 * 每个文件记录 {mtimeMs, size, offset}：
 *  - mtime 和 size 都没变     -> 完全跳过
 *  - size 变大且 mtime 变新   -> 从 offset 续读，只解析新增字节
 *  - size 变小（被截断/重写） -> 整文件重解析
 *
 * 日志文件消失时**保留统计**，只把会话标成 sourceDeleted：Claude Code 会按 cleanupPeriodDays
 * （默认 30 天）删掉不活跃的 CLI 会话日志，会话也可能被手动删掉。要是跟着删，看板上的
 * 历史会悄悄变少，也就没法和过去比。这类记录可以用 removeFromStats 手动删掉。
 */
export async function refreshUsage({ force = false } = {}) {
  const started = Date.now();
  const { cache, rebuildReason } = await readCache();
  const fullRebuild = force || !!rebuildReason;
  // 全量重建会清空注册表，先留一份：里面的 startedAt 还能接着用，省得重读文件头。
  const knownRegistry = cache.fileRegistry || {};
  if (fullRebuild) {
    // 全量重建只重算「日志还在」的部分。原始日志已删除的会话没法重算，连同分片原样留下。
    const kept = carryOverArchive(cache);
    const keptShards = new Map();
    for (const sessionId of Object.keys(kept.sessions)) {
      keptShards.set(sessionId, await readTurnsShard(sessionId));
    }
    cache.fileRegistry = {};
    cache.sessions = kept.sessions;
    cache.conversations = kept.conversations;
    cache.promptIndex = kept.promptIndex;
    await io.clearAllTurns();
    for (const [sessionId, turns] of keptShards) await writeTurnsShard(sessionId, turns);
  }
  if (!cache.promptIndex) cache.promptIndex = {};

  // 解析顺序决定共享历史记在谁名下：global 去重下「谁先解析谁记账」。
  // 编辑已发送的提示词、/branch、--fork-session 都会新开一个会话文件，把分叉点之前的
  // 历史原样复制进去（uuid、时间戳都不变）。按路径排序时这段历史归谁取决于会话 ID 的
  // 字母顺序，常常挂到后来的副本上，原会话反而只剩被放弃的那一段。
  // 所以按「文件里第一条带时间戳的记录」排序：副本的第一条是它被创建的时刻，复制来的
  // 历史排在后面，原会话一定先解析。增量刷新时新文件本来就排在已记账的文件之后，两者一致。
  const listed = await io.listLogFiles();
  const startedAt = new Map();
  for (const file of listed) {
    const reg = knownRegistry[file.filePath];
    // 追加写不会改动文件头；文件变小说明被重写过，要重新读。
    const known = reg && 'startedAt' in reg && file.size >= reg.size;
    startedAt.set(file.filePath, known ? reg.startedAt : await readStartedAt(file.filePath));
  }
  const sessionStart = new Map();
  for (const file of listed) {
    if (!file.subagent) sessionStart.set(file.sessionId, startedAt.get(file.filePath));
  }
  // 子 agent 日志跟着父会话排，并排在父会话主日志之后：它要用主日志建好的 promptIndex。
  const orderKey = (file) =>
    (file.subagent && sessionStart.has(file.sessionId)
      ? sessionStart.get(file.sessionId)
      : startedAt.get(file.filePath)) || '￿';
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const files = listed.sort((a, b) =>
    cmp(orderKey(a), orderKey(b))
    || cmp(a.subagent ? 1 : 0, b.subagent ? 1 : 0)
    || cmp(a.filePath, b.filePath)
  );
  const stats = {
    filesScanned: files.length,
    subagentFiles: files.filter((f) => f.subagent).length,
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
    filesArchived: 0,
    logDirUnavailable: false,
    rebuildReason,
  };

  // 日志文件不见了：统计保留，只打标记（原因见函数注释）。
  // 一个文件都列不出来、缓存里却登记着文件，多半是日志目录暂时读不到（权限被拒、
  // 外置盘没挂上），不是真的全删了 —— 这时什么都不动，等目录回来。
  const registered = Object.keys(cache.fileRegistry);
  if (!files.length && registered.length) {
    stats.logDirUnavailable = true;
  } else {
    const alive = new Set(files.map((f) => f.filePath));
    const liveSessions = new Set(files.filter((f) => !f.subagent).map((f) => f.sessionId));
    const detectedAt = new Date().toISOString();
    for (const filePath of registered) {
      if (alive.has(filePath)) continue;
      const reg = cache.fileRegistry[filePath];
      delete cache.fileRegistry[filePath];
      // 子 agent 日志单独消失：它的开销早已写进父会话分片，留着即可。
      // 主日志换了位置（同一个 sessionId 出现在新路径下）会在下面从头重新解析，也不算删除。
      if (reg.subagent || liveSessions.has(reg.sessionId)) continue;
      const session = cache.sessions[reg.sessionId];
      if (session && !session.sourceDeleted) {
        session.sourceDeleted = detectedAt;
        stats.filesArchived++;
      }
    }
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
    const subagent = file.subagent || null;
    // 子 agent 的 turn 写进父会话的分片，所以哪怕它是从头解析，也是在父会话现有数据上追加。
    const append = resume || !!subagent;
    const prev = append ? cache.sessions[sessionId] : null;
    const oldTurns = await readTurnsShard(sessionId);
    // 从头解析时，作废的只是「这个文件上次写进来的那部分」：主日志重解析不能顺手丢掉
    // 子 agent 的 turn（子 agent 文件没变就不会被重读），反过来也一样。
    const ownedByThisFile = (t) => (subagent ? t.subagent === subagent : !t.subagent);
    const existingTurns = resume ? oldTurns : oldTurns.filter((t) => !ownedByThisFile(t));

    if (!resume) {
      // 先把这部分旧数据从全局去重表里摘掉，否则重解析出来的行会被自己的旧记录判成重复。
      for (const t of oldTurns) {
        if (!t.dedupKey || !ownedByThisFile(t)) continue;
        const owner = seenOwner.get(t.dedupKey);
        if (owner && owner.sessionId === sessionId && ownedByThisFile(owner)) seenOwner.delete(t.dedupKey);
      }
      if (!subagent) {
        for (const [cid, conv] of Object.entries(cache.conversations)) {
          if (conv.sessionId === sessionId) delete cache.conversations[cid];
        }
      }
    }

    const conversations = new Map();
    if (append) {
      for (const [cid, conv] of Object.entries(cache.conversations)) {
        if (conv.sessionId === sessionId) conversations.set(cid, conv);
      }
    }
    if (!cache.promptIndex[sessionId]) cache.promptIndex[sessionId] = {};
    // 子 agent 的说明文字不单独落盘（它是任务原文），续读时从已有 turn 上取回。
    const knownAgent = subagent ? existingTurns.find((t) => t.subagent === subagent) : null;

    const ctx = {
      sessionId,
      subagent,
      agentLabel: knownAgent ? knownAgent.agent || null : null,
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
      promptIndex: cache.promptIndex[sessionId],
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
      // 主日志重新出现（从废纸篓拿回来）就清掉标记；只有子 agent 文件更新时沿用。
      sourceDeleted: (subagent && prev && prev.sourceDeleted) || null,
    };

    cache.fileRegistry[file.filePath] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      offset: file.size,
      startedAt: startedAt.get(file.filePath) ?? null,
      sessionId,
      lastConversationId: ctx.currentConvId,
      convSeq: ctx.convSeq,
      turnSeq: ctx.turnSeq,
      ...(subagent ? { subagent } : {}),
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
 * 把 resume/fork 复制出来的重复对话合并回一条。
 *
 * Claude Code 在 resume 时会把历史条目连 uuid 一起原样写进新的 session 文件，
 * 而 conversation 的 id 是「会话 + uuid」，于是同一次提问在每个继承过它的会话里
 * 都留下一条记录。turn 已经全局去重，总额不受影响，但列表里会并排出现几行
 * 一模一样的内容；被 resume 打断的那次提问更糟——它的开销被切成两半，
 * 分别挂在两条记录上，看起来像是同一句话问了两次、各花了一笔钱。
 *
 * 按 uuid 合成一条，归给 turn 实际落在的那个会话——不能只看谁开始得早：
 * turn 的去重归属由解析顺序决定，和会话起始时间未必一致，归错了会话列表里
 * 就会出现「总额里有这笔钱、点进去却没有对应的对话」。压缩记录一条 turn
 * 都没有，这时才退回最早开始的那个会话。
 *
 * 返回「原 id -> 保留 id」的映射，调用方据此把 turn 就地改写并归集。
 */
function mergeReplayedConversations(cache, shardTurns) {
  const groups = new Map();
  for (const cid of Object.keys(cache.conversations)) {
    const uuid = cid.slice(cid.indexOf(':') + 1);
    // 缺 uuid 时退回的 `seqN` 只在单个会话内唯一，跨会话同名是巧合而非同一条。
    if (!uuid || uuid.startsWith('seq')) continue;
    const list = groups.get(uuid);
    if (list) list.push(cid);
    else groups.set(uuid, [cid]);
  }

  // 每条记录名下实际有多少 turn。
  const weight = new Map();
  for (const kept of shardTurns.values()) {
    for (const t of kept) weight.set(t.conversationId, (weight.get(t.conversationId) || 0) + 1);
  }

  const canonical = new Map();
  for (const cids of groups.values()) {
    if (cids.length < 2) continue;
    const startedAt = (cid) => {
      const session = cache.sessions[cache.conversations[cid].sessionId];
      return (session && session.firstActivity) || '\uffff';
    };
    // 排序键全部相同时用 id 兜底，保证每次刷新留下的都是同一条，
    // 否则下钻链接会在两次刷新之间失效。
    cids.sort((a, b) => {
      const wa = weight.get(a) || 0;
      const wb = weight.get(b) || 0;
      if (wa !== wb) return wb - wa;
      const sa = startedAt(a);
      const sb = startedAt(b);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a < b ? -1 : 1;
    });

    const keep = cids[0];
    const target = cache.conversations[keep];
    for (const cid of cids) {
      canonical.set(cid, keep);
      if (cid === keep) continue;
      const conv = cache.conversations[cid];
      if (conv.date && conv.date < target.date) target.date = conv.date;
      // 压缩规模只写在记录到 compact_boundary 的那一份上，别让它跟着副本一起删掉。
      if (!target.compaction && conv.compaction) target.compaction = conv.compaction;
      delete cache.conversations[cid];
    }
  }
  return canonical;
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
  // 分片先整体读进内存：合并归属得先知道 turn 落在哪儿，随后累计还要再走一遍。
  // 实测 9000 条 turn，不值得为省这点内存把磁盘读两遍。
  const shardTurns = new Map();
  const shardDirty = new Set();
  for (const sessionId of Object.keys(cache.sessions)) {
    const turns = await readTurnsShard(sessionId);
    // 剔除同键冲突中落败的 turn（可能是在别的文件里被更完整的副本取代的）。
    const kept = superseded.size
      ? turns.filter((t) => !superseded.has(sessionId + '|' + t.id))
      : turns;
    if (kept.length !== turns.length) shardDirty.add(sessionId);
    shardTurns.set(sessionId, kept);
  }

  const canonical = mergeReplayedConversations(cache, shardTurns);
  // 分片里的 turn 指向一条早已不存在的对话时（典型情况：resume 出来的会话继续往
  // 上一次刷新时被合并掉的副本上写），按 uuid 找回合并后留下的那一条，否则就成了孤儿。
  const byUuid = new Map();
  for (const cid of Object.keys(cache.conversations)) {
    const key = conversationUuid(cid);
    if (key !== cid && !byUuid.has(key)) byUuid.set(key, cid);
  }
  const convTotals = new Map();
  const convModels = new Map();
  const convShards = new Map();

  for (const [sessionId, kept] of shardTurns) {
    // 归到被合并掉的副本名下的 turn 就地改指到保留的那条，否则它们会变成
    // 指向已删除记录的孤儿：金额算得对，下钻却是空的。
    for (const t of kept) {
      let canon = canonical.get(t.conversationId);
      if (!canon && !cache.conversations[t.conversationId]) canon = byUuid.get(conversationUuid(t.conversationId));
      if (canon && canon !== t.conversationId) {
        t.conversationId = canon;
        shardDirty.add(sessionId);
      }
    }
    if (shardDirty.has(sessionId)) await writeTurnsShard(sessionId, kept);

    const session = cache.sessions[sessionId];
    Object.assign(session, ZERO_TOTALS);
    const models = new Set();
    session.estimatedPricing = false;

    for (const t of kept) {
      accumulate(session, t);
      models.add(t.model);
      if (t.pricingEstimated) session.estimatedPricing = true;

      const convId = t.conversationId;
      let ct = convTotals.get(convId);
      if (!ct) {
        ct = Object.assign({}, ZERO_TOTALS);
        convTotals.set(convId, ct);
        convModels.set(convId, new Set());
        convShards.set(convId, new Set());
      }
      accumulate(ct, t);
      convModels.get(convId).add(t.model);
      // 合并后一条对话的 turn 可能横跨两个会话的分片，记下都在哪儿，下钻才找得全。
      convShards.get(convId).add(sessionId);
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
    const shards = convShards.get(cid);
    // 只有跨分片时才记，绝大多数对话的 turn 就在 id 自带的那个会话里。
    if (shards && (shards.size > 1 || !shards.has(conv.sessionId))) {
      conv.shards = Array.from(shards).sort();
    } else {
      delete conv.shards;
    }
    const session = cache.sessions[conv.sessionId];
    conv.projectKey = session ? session.projectKey : null;
    conv.projectName = session ? session.projectName : null;
    conv.sessionName = session ? session.sessionName : conv.sessionId;
    conv.sourceDeleted = session ? session.sourceDeleted || null : null;
  }

  // 会话记录和日志登记都已经没有了的 promptIndex，不会再有人用到。
  const registeredSessions = new Set(Object.values(cache.fileRegistry).map((r) => r.sessionId));
  for (const sid of Object.keys(cache.promptIndex)) {
    if (!cache.sessions[sid] && !registeredSessions.has(sid)) delete cache.promptIndex[sid];
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
