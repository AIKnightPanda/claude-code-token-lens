/**
 * 模型计价表。
 *
 * 费率来源：Anthropic 官方 API 价目 + models.dev 快照（两者交叉验证一致），
 * 单位为 USD / 1M tokens。这里只放「基础输入 / 输出 / 缓存读取」三项，
 * 缓存写入按官方规则由输入价推导：
 *   - 5 分钟缓存写入 = input × 1.25
 *   - 1 小时缓存写入 = input × 2.0
 * 参见 CACHE_WRITE_5M_MULTIPLIER / CACHE_WRITE_1H_MULTIPLIER。
 *
 * 注意：历史版本这里误用了 Claude 3 时代的价格（opus 15/75、sonnet 3/15、
 * haiku 0.25/1.25），套在 Claude 5 的模型 ID 上，导致成本严重失真。
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/** Opus 5 / Opus 4.8 的 fast 模式按 2 倍标准价计费。 */
export const FAST_MODE_MULTIPLIER = 2.0;

const PRICING = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1.0 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/**
 * 模型 ID 归一化：剥离日期后缀与平台前缀，例如
 *   claude-haiku-4-5-20251001 -> claude-haiku-4-5
 *   anthropic/claude-opus-5   -> claude-opus-5
 *   us.anthropic.claude-opus-5-v1:0 -> claude-opus-5
 */
function normalizeModel(model) {
  let m = String(model || '').toLowerCase().trim();
  m = m.replace(/^[a-z0-9-]*\.?anthropic[./]/, '');
  m = m.replace(/^anthropic\//, '');
  m = m.replace(/[:@].*$/, '');
  m = m.replace(/-v\d+$/, '');
  m = m.replace(/-\d{8}$/, '');
  return m;
}

/**
 * 取模型费率。找不到精确匹配时按系列回退，并标记 estimated，
 * 让上层可以把「估算价」和「已知价」区分开来，而不是静默当成准确值。
 */
export function getPricing(model) {
  const m = normalizeModel(model);
  if (PRICING[m]) return { ...PRICING[m], model: m, estimated: false };

  // 系列回退：未知的新版本至少落在同一档次，而不是掉进 sonnet 兜底价。
  const series = [
    ['fable', 'claude-fable-5'],
    ['opus', 'claude-opus-5'],
    ['sonnet', 'claude-sonnet-5'],
    ['haiku', 'claude-haiku-4-5'],
  ];
  for (const [needle, key] of series) {
    if (m.includes(needle)) return { ...PRICING[key], model: m, estimated: true };
  }
  return { ...PRICING['claude-sonnet-5'], model: m, estimated: true };
}

/**
 * 从一条 usage 中拆出各类 token。
 *
 * cache_creation 若存在则以它为准（区分 5m / 1h 两档），
 * 否则退回扁平的 cache_creation_input_tokens（全部按 5m 计）。
 */
export function extractTokens(usage) {
  const u = usage || {};
  const breakdown = u.cache_creation;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  if (breakdown && typeof breakdown === 'object') {
    cacheWrite5m = breakdown.ephemeral_5m_input_tokens || 0;
    cacheWrite1h = breakdown.ephemeral_1h_input_tokens || 0;
  } else {
    cacheWrite5m = u.cache_creation_input_tokens || 0;
  }
  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const cacheReadTokens = u.cache_read_input_tokens || 0;
  const cacheWriteTokens = cacheWrite5m + cacheWrite1h;

  const serverToolUse = u.server_tool_use || {};
  return {
    inputTokens,
    outputTokens,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteTokens,
    cacheReadTokens,
    cacheTokens: cacheWriteTokens + cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
    webSearchRequests: serverToolUse.web_search_requests || 0,
    webFetchRequests: serverToolUse.web_fetch_requests || 0,
  };
}

/** Web 搜索按次计费：$10 / 1000 次。web_fetch 目前不单独计费。 */
export const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

/**
 * 按 token 类型拆分单条 assistant 响应的成本（USD）。
 *
 * 拆开而不是只给一个总数，是因为「哪一类 token 花了钱」和「哪一类 token 多」
 * 往往是两回事：缓存读取通常占 token 总量的绝大部分，但单价只有输入价的
 * 1/10，看总量会严重误判成本结构。
 *
 * `<synthetic>` 是 Claude Code 本地生成的消息（API 报错、请求中断提示），
 * 没有真实调用，全部计 0。
 */
export function calculateCostBreakdown(tokens, model, { speed } = {}) {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, serverTools: 0, total: 0 };
  if (model === '<synthetic>') return zero;

  const p = getPricing(model);
  const m = speed === 'fast' ? FAST_MODE_MULTIPLIER : 1;

  const input = (tokens.inputTokens * p.input) / 1e6 * m;
  const output = (tokens.outputTokens * p.output) / 1e6 * m;
  const cacheWrite =
    (tokens.cacheWrite5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cacheWrite1h * p.input * CACHE_WRITE_1H_MULTIPLIER) / 1e6 * m;
  const cacheRead = (tokens.cacheReadTokens * p.cacheRead) / 1e6 * m;
  // 服务端工具按次计费，不随 token 走，也不受 fast 倍率影响。
  const serverTools = tokens.webSearchRequests * WEB_SEARCH_COST_PER_REQUEST;

  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    serverTools,
    total: input + output + cacheWrite + cacheRead + serverTools,
  };
}

/** 单条响应的总成本（USD）。 */
export function calculateCost(tokens, model, options) {
  return calculateCostBreakdown(tokens, model, options).total;
}
