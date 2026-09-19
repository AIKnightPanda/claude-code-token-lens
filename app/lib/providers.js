/**
 * 数据源注册表：Dashboard 组件按 provider 拿数据接口，UI 本身不关心
 * 数据到底来自 Claude Code 还是 Codex —— 两边的概念已经在各自的
 * parser 里对齐成同样的形状（project/session/conversation/turn）。
 *
 * 两侧的 readCache/refreshUsage/getTurnsForConversation 来自完全独立的模块
 * （parser-tauri.js 和 codex-parser-tauri.js），互不 import，
 * 一侧解析出错不会导致另一侧的函数跟着抛异常。
 */
import { readCache as claudeReadCache, refreshUsage as claudeRefreshUsage, getTurnsForConversation as claudeGetTurns, removeFromStats as claudeRemoveFromStats } from './parser-tauri';
import { listPricing as claudeListPricing, PRICING_AS_OF as CLAUDE_PRICING_AS_OF } from './pricing';
import {
  readCache as codexReadCache, refreshUsage as codexRefreshUsage, getTurnsForConversation as codexGetTurns,
  UNASSIGNED_PROJECT_KEY, INTERNAL_CHECK_KIND,
} from './codex-parser-tauri';
import { listPricing as codexListPricing, PRICING_AS_OF as CODEX_PRICING_AS_OF } from './pricing-codex';
import { TOKEN_TIPS } from './token-tips';

export const PROVIDERS = {
  claude: {
    key: 'claude',
    label: 'Claude Code',
    plan: 'Pro/Max',
    readCache: claudeReadCache,
    refreshUsage: claudeRefreshUsage,
    getTurnsForConversation: claudeGetTurns,
    // 从统计中移除会话/对话。Codex 侧还没有实现，界面据此决定是否显示移除按钮。
    removeFromStats: claudeRemoveFromStats,
    // 价目表详情弹窗用：每一行的字段取决于 pricingColumns 列出的列。
    pricingTable: claudeListPricing(),
    pricingAsOf: CLAUDE_PRICING_AS_OF,
    pricingColumns: ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'],
    tokenTips: TOKEN_TIPS.claude,
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    plan: 'Plus/Pro',
    readCache: codexReadCache,
    refreshUsage: codexRefreshUsage,
    getTurnsForConversation: codexGetTurns,
    // Claude Code 没有这两个概念，两个字段对它就是 undefined——UI 里的比较自然不会命中。
    unassignedProjectKey: UNASSIGNED_PROJECT_KEY,
    internalCheckKind: INTERNAL_CHECK_KIND,
    pricingTable: codexListPricing(),
    pricingAsOf: CODEX_PRICING_AS_OF,
    pricingColumns: ['input', 'output', 'cacheWrite', 'cacheRead'],
    tokenTips: TOKEN_TIPS.codex,
  },
};

export const PROVIDER_ORDER = ['claude', 'codex'];
export const DEFAULT_PROVIDER = 'claude';
