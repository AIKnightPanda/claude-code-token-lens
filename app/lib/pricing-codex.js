/**
 * Codex（本机「ChatGPT 桌面版」实际读取的日志来源）计价表。
 *
 * Codex 是订阅制产品，没有官方公开的分 token 价格表 —— 这里的数字是按 OpenAI
 * API 同代模型的等价价格估算的，口径与 pricing.js 对 Claude 订阅成本的处理一致：
 * 都标 estimated，界面上会提示这是「等价成本」而非账单金额。
 *
 * 缓存读取按输入价的 10% 计（与 OpenAI 已公开的缓存折扣比例一致）；
 * 缓存写入不加价 —— OpenAI 的自动提示缓存本身不收额外费用，写入时按普通输入价计。
 */
export const CACHE_READ_DISCOUNT = 0.1;

/**
 * 这份价目表最后对照 OpenAI API 同代模型价目核实过的日期。界面上用来标注
 * 「现在看到的成本，是按哪个时间点的价目表算出来的」，改价目表时记得同步改这个日期。
 */
export const PRICING_AS_OF = '2026-09-12';

const PRICING = {
  'gpt-6-astra': { input: 3.5, output: 28 },
  'gpt-5.6-terra': { input: 2.5, output: 20 },
  'gpt-5.6-sol': { input: 2.5, output: 20 },
  'gpt-5.5': { input: 1.75, output: 14 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'codex-mini': { input: 1.5, output: 6 },
};

/**
 * 模型 ID 归一化：剥离厂商前缀与常见变体标记，例如
 *   openai/gpt-5.6-terra -> gpt-5.6-terra
 */
function normalizeModel(model) {
  let m = String(model || '').toLowerCase().trim();
  m = m.replace(/^openai\//, '');
  m = m.replace(/[:@].*$/, '');
  return m;
}

/**
 * 取模型费率。找不到精确匹配时按系列回退（从最新到最旧尝试子串匹配），
 * 并标记 estimated —— codex-auto-review 这类内部路由用的虚拟模型名
 * 也会落到这里，兜底价与 estimated 标记一致对待。
 */
export function getPricing(model) {
  const m = normalizeModel(model);
  if (PRICING[m]) return { ...PRICING[m], model: m, estimated: false };

  const series = [
    'gpt-6', 'gpt-5.6', 'gpt-5.5', 'gpt-5.1',
    'gpt-5-mini', 'gpt-5-nano', 'codex-mini', 'gpt-5',
  ];
  for (const key of series) {
    if (m.includes(key) && PRICING[key]) return { ...PRICING[key], model: m, estimated: true };
  }
  return { ...PRICING['gpt-5'], model: m, estimated: true };
}

/** 给界面展示完整价目表：缓存读取的折扣比例提前算成实际单价，不用 UI 自己重算。 */
export function listPricing() {
  return Object.keys(PRICING).map((model) => {
    const p = PRICING[model];
    return {
      model,
      input: p.input,
      output: p.output,
      // 写入不加价，按普通输入价计——和 calculateCostBreakdown 的口径一致。
      cacheWrite: p.input,
      cacheRead: p.input * CACHE_READ_DISCOUNT,
    };
  });
}

/**
 * 从一条 token_count 事件的用量对象中拆出各类 token。
 *
 * Codex 的用量字段是「累计口径」——input_tokens 已经包含 cached_input_tokens，
 * total_tokens = input_tokens + output_tokens（output_tokens 又已经包含
 * reasoning_output_tokens）。这里按 Claude 侧的展示习惯拆成互斥的四类，
 * 使 totalTokens 等于四类之和，与 UI 的列布局对齐。
 */
export function extractTokens(usage) {
  const u = usage || {};
  const inputTotal = u.input_tokens || 0;
  const cacheReadTokens = Math.min(u.cached_input_tokens || 0, inputTotal);
  const cacheWriteTokens = Math.min(
    u.cache_write_input_tokens || 0,
    Math.max(inputTotal - cacheReadTokens, 0)
  );
  const inputTokens = Math.max(inputTotal - cacheReadTokens - cacheWriteTokens, 0);
  const outputTokens = u.output_tokens || 0;
  const reasoningOutputTokens = Math.min(u.reasoning_output_tokens || 0, outputTokens);

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    cacheTokens: cacheWriteTokens + cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
  };
}

/** 按 token 类型拆分单次调用的成本（USD）。 */
export function calculateCostBreakdown(tokens, model) {
  const p = getPricing(model);
  const input = (tokens.inputTokens * p.input) / 1e6;
  const output = (tokens.outputTokens * p.output) / 1e6;
  // 写入不加价，按普通输入价计。
  const cacheWrite = (tokens.cacheWriteTokens * p.input) / 1e6;
  const cacheRead = (tokens.cacheReadTokens * p.input * CACHE_READ_DISCOUNT) / 1e6;
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
  };
}

/** 单次调用的总成本（USD）。 */
export function calculateCost(tokens, model) {
  return calculateCostBreakdown(tokens, model).total;
}
