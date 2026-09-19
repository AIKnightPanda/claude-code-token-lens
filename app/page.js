"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line
} from 'recharts';
import {
  Activity, DollarSign, Cpu, Calendar, AlertCircle, TerminalSquare, RefreshCw,
  FolderOpen, MessageSquare, BarChart3, ChevronRight, ChevronUp, ChevronDown, Check,
  ChevronsUpDown, AlignLeft, ArrowLeft, X, Globe, Info, ExternalLink, Trash2, Receipt, Lightbulb
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { i18n } from './i18n';
import VolumeVsCost from './VolumeVsCost';
import { PROVIDERS, PROVIDER_ORDER, DEFAULT_PROVIDER } from './lib/providers';

const PROJECT_URL = 'https://github.com/AIKnightPanda/claude-code-token-lens';
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '';

/** lucide 从 v1 起不再收录品牌图标，GitHub 的图形只能自己带。 */
function GithubIcon({ size = 15 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </svg>
  );
}

function toPayload(cache) {
  if (!cache) return null;
  return {
    generatedAt: cache.generatedAt,
    summary: cache.summary,
    projects: cache.projects,
    daily: cache.daily,
    sessions: Object.values(cache.sessions).filter((s) => !s.attachedTo),
    conversations: Object.values(cache.conversations),
    stats: cache.stats,
  };
}
import './globals.css';

const COLORS = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

/** 表格首屏渲染行数上限。一次性渲染上万行 DOM 会直接卡死浏览器。 */
const PAGE_SIZE = 100;

const fmtDate = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '-';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return (
    <div style={{ lineHeight: '1.2' }}>
      <div>{`${mm}/${dd}`}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginTop: '2px' }}>{`${hh}:${mi}`}</div>
    </div>
  );
};

const fmtDateOnly = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 渲染 daily 表的日期。
 *
 * daily 的 key 已经是本地日的 YYYY-MM-DD，不能再交给 new Date() 解析 ——
 * 纯日期字符串会被当成 UTC 午夜，在负时区会整体显示成前一天。
 */
const fmtDayLabel = (day, locale) => {
  if (!day) return '-';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
};

const fmtNum = (n) => (n || 0).toLocaleString();
const fmtCost = (n, digits = 4) => `$${(n || 0).toFixed(digits)}`;
const fmtQuotaPct = (n) => (n < 1 ? '<1%' : `≈${Math.round(n)}%`);
const fmtQuotaLeft = (used) => (used == null ? '—' : `${Math.min(Math.max(100 - used, 0), 100)}%`);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * 展示用的会话短 ID。Claude Code 的 sessionId 本身就是纯 UUID，首段已经够用。
 * Codex 的 sessionId 是整个 rollout 文件名（rollout-2026-09-11T00-09-42-<uuid>），
 * 直接切片/按 "-" 分段拿到的全是 "rollout"，所有会话显示出来一个样——
 * 改成从字符串里找那段真正的 UUID，再取它的首段。
 */
const shortSessionId = (sessionId) => {
  const id = String(sessionId || '');
  const match = id.match(UUID_RE);
  return (match ? match[0] : id).slice(0, 8);
};

/**
 * 统计块的紧凑写法：2,400,580,317 → 2.4B / 24亿。
 * 六列布局下每块只有一两百像素，长数字原样放不下，窄的时候用它顶上。
 */
const fmtCompact = (n, locale) =>
  (n || 0).toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 1 });

/**
 * 成本的紧凑写法。中文 locale 下 1751.87 的 compact 是「1751.9」——
 * 没短多少还丢了角分，这种情况不如直接取整成 $1,752。
 */
const fmtCostCompact = (n, locale) => {
  const compact = `$${fmtCompact(n, locale)}`;
  const rounded = `$${Math.round(n || 0).toLocaleString(locale)}`;
  return compact.length <= rounded.length ? compact : rounded;
};

/** 按完整字符串的长度分档，CSS 据此决定多窄才需要换成紧凑写法。 */
const statLenTier = (text) => {
  const len = String(text).length;
  if (len >= 14) return 'len-xxl';
  if (len >= 12) return 'len-xl';
  if (len >= 11) return 'len-lg';
  if (len >= 9) return 'len-md';
  return 'len-sm';
};

/**
 * 顶部统计块：图标居左，标题 + 数值居右，整体只有一行图标的高度。
 * value 是完整值，compact 是放不下时的替代写法（两者相同就不渲染）。
 */
const StatCard = ({ icon, tone, title, value, compact }) => {
  // 短不了就别换：换了既不省地方，又平白丢精度
  const hasCompact = compact != null && compact.length < String(value).length;
  return (
    <div className="card stat-card hover-lift">
      <div className={`stat-icon icon-bg-${tone} text-${tone}`}>{icon}</div>
      <div className="stat-text">
        <p className="stat-title">{title}</p>
        {/* aria-label 固定读完整值：紧凑写法是纯视觉降级，不该让读屏用户听到 2.4B */}
        <h2 className={`stat-value ${statLenTier(value)}`} title={value} aria-label={value}>
          <span className="stat-value-full">{value}</span>
          {hasCompact && <span className="stat-value-compact">{compact}</span>}
        </h2>
      </div>
    </div>
  );
};

/** 折叠时最多显示几行。 */
const PROMPT_LINES = 3;

/**
 * 提示词展示组件：
 * 超过 3 行时折叠并在第 3 行末尾悬浮显示「… 展开」；
 * 展开后显示完整文本，并在底部右侧显示「收起」按钮。
 */
const ExpandablePrompt = ({ prompt, t }) => {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;

    const checkOverflow = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const limit = lineHeight * PROMPT_LINES + 1.5;
      const isOver = el.scrollHeight > limit;
      setCanExpand(isOver);
      if (!isOver) {
        setExpanded(false);
      }
    };

    checkOverflow();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [prompt]);

  if (!prompt) return null;

  return (
    <div className={`prompt-wrapper prompt-body ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div
        ref={textRef}
        className={`prompt-text ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      >
        {prompt}
      </div>

      {!expanded && canExpand && (
        <button
          type="button"
          className="prompt-expand-overlay"
          onClick={() => setExpanded(true)}
          title={t.readMore}
        >
          <span className="prompt-expand-btn">{t.readMore}</span>
        </button>
      )}

      {expanded && canExpand && (
        <div className="prompt-collapse-bar">
          <button
            type="button"
            className="prompt-collapse-btn"
            onClick={() => setExpanded(false)}
          >
            {t.showLess}
            <ChevronUp size={13} />
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * 自定义日期范围下拉菜单：
 * 替代 macOS 原生系统 select，保证弹窗字体与样式和全站一致（Inter/Outfit），
 * 支持点击外部自动收起与 Escape 键盘关闭。
 */
const DateRangeDropdown = ({ value, onChange, t }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const options = [
    { value: 'all', label: t.allTime },
    { value: '30d', label: t.last30 },
    { value: '7d', label: t.last7 },
  ];

  const currentLabel = options.find((o) => o.value === value)?.label || t.allTime;

  useEffect(() => {
    if (!open) return;
    const handleDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="date-select-wrapper" ref={containerRef}>
      <button
        type="button"
        className={`refresh-btn date-select-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.range}
      >
        <Calendar size={18} className="date-select-icon" />
        <span>{currentLabel}</span>
        <ChevronDown size={14} className={`date-select-arrow ${open ? 'is-open' : ''}`} />
      </button>

      {open && (
        <div className="date-dropdown-menu" role="listbox">
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`date-dropdown-item ${isSelected ? 'is-selected' : ''}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {isSelected && <Check size={14} className="date-dropdown-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * 唤不起系统浏览器时的兜底说明框。
 *
 * 桌面端没有地址栏，一个打不开的链接对用户来说就是死路；把地址摆出来、
 * 顺手放进剪贴板，他自己还能打开。
 */
const ProjectLinkDialog = ({ copied, t, onClose }) => (
  <div className="link-dialog-backdrop" onClick={onClose}>
    <div className="link-dialog" role="dialog" aria-modal="true"
      aria-label={t.projectHomeTitle} onClick={(e) => e.stopPropagation()}>
      <h3 className="link-dialog-title"><GithubIcon size={18} />{t.projectHomeTitle}</h3>
      <p className="link-dialog-body">{t.projectHomeBody}</p>
      <code className="link-dialog-url">{PROJECT_URL}</code>
      <p className="link-dialog-hint">{copied ? t.linkCopied : t.linkCopyFailed}</p>
      <button type="button" className="link-dialog-close" onClick={onClose}>{t.dismiss}</button>
    </div>
  </div>
);

/**
 * 删除缓存记录前的确认框。
 *
 * 只有原始日志已经不在的记录才有这个操作，删了就彻底找不回来，
 * 所以把对象、金额和后果都摆出来再让人点。
 */
const RemoveDialog = ({ target, t, busy, error, onCancel, onConfirm }) => {
  const title = target.kind === 'session' ? t.removeSessionTitle : t.removeConversationTitle;
  return (
    <div className="link-dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="link-dialog" role="alertdialog" aria-modal="true"
        aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="link-dialog-title"><Trash2 size={18} />{title}</h3>
        <p className="remove-dialog-target">{target.label}</p>
        <p className="remove-dialog-meta">{fmtCost(target.cost)} · {fmtNum(target.tokens)} tokens</p>
        <p className="link-dialog-body">{t.removeBody}</p>
        {target.sharedHistory && <p className="link-dialog-body">{t.removeSharedHistory}</p>}
        {error && <p className="remove-dialog-error">{t.removeFailed}: {error}</p>}
        <div className="remove-dialog-actions">
          <button type="button" className="link-dialog-close" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="button" className="remove-dialog-confirm" onClick={onConfirm} disabled={busy}>
            {busy ? t.removing : t.removeConfirm}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 价目表弹窗里每一列对应的文案 key——哪个 provider 展示哪些列由 provider.pricingColumns 决定。 */
const PRICING_COLUMN_LABEL_KEYS = {
  input: 'pricingInput',
  output: 'pricingOutput',
  cacheWrite5m: 'pricingCacheWrite5m',
  cacheWrite1h: 'pricingCacheWrite1h',
  cacheWrite: 'pricingCacheWrite',
  cacheRead: 'pricingCacheRead',
};

/**
 * 价目表详情：当前成本到底是怎么算出来的，在这之前整个应用里没有地方能看到。
 * 两个 provider 共用同一个组件，展示哪些列（Claude 的缓存写入拆成 5m/1h 两档，
 * Codex 只有一档）由 provider.pricingColumns 决定，不用各写一份表格。
 */
const PricingDialog = ({ provider, t, onClose }) => (
  <div className="link-dialog-backdrop" onClick={onClose}>
    <div className="link-dialog pricing-dialog" role="dialog" aria-modal="true"
      aria-label={t.pricingTitle} onClick={(e) => e.stopPropagation()}>
      <h3 className="link-dialog-title"><Receipt size={18} />{provider.label} {t.pricingTitle}</h3>
      <p className="link-dialog-body">
        {t.pricingBody}
        <br />
        <span className="pricing-as-of">{t.pricingAsOf} {provider.pricingAsOf}</span>
      </p>
      <div className="pricing-table-wrapper">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>{t.pricingModel}</th>
              {provider.pricingColumns.map((col) => (
                <th key={col} className="text-right">{t[PRICING_COLUMN_LABEL_KEYS[col]]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {provider.pricingTable.map((row) => (
              <tr key={row.model}>
                <td className="pricing-model-cell">{row.model}</td>
                {provider.pricingColumns.map((col) => (
                  <td key={col} className="text-right">{fmtCost(row[col], 2)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="link-dialog-hint">{t.pricingUnit}</p>
      <button type="button" className="link-dialog-close" onClick={onClose}>{t.dismiss}</button>
    </div>
  </div>
);

/**
 * 省 token 小技巧：和价目表挂在同一排按钮上，但内容按 provider 分开维护
 * （两边机制相通，数字和细节不一样，套模板硬塞变量反而不准），
 * 见 lib/token-tips.js。同一份内容还要分中英文，所以还得按 lang 取一次。
 */
const TokenTipsDialog = ({ provider, t, lang, onClose }) => {
  const { highlight, tips } = provider.tokenTips[lang] || provider.tokenTips.en;
  return (
    <div className="link-dialog-backdrop" onClick={onClose}>
      <div className="link-dialog token-tips-dialog" role="dialog" aria-modal="true"
        aria-label={t.tokenTipsTitle} onClick={(e) => e.stopPropagation()}>
        <h3 className="link-dialog-title"><Lightbulb size={18} />{provider.label} {t.tokenTipsTitle}</h3>
        {/* 额度换算是心理模型，不是可执行的动作，单独用高亮块常显在最上面，
            不参与下面的编号、也不折叠，避免被列表埋没。 */}
        <div className="token-tip-highlight">
          <div className="token-tip-highlight-title">{highlight.title}</div>
          <p className="token-tip-highlight-body">{highlight.body}</p>
        </div>
        {/* 不分类，直接列出每条建议并编号：标题就是明确的行动建议本身，一眼能
            扫完有几条；解释放进 <details> 默认收起，想深入了解哪条自己展开。 */}
        <div className="token-tips-body">
          {tips.map((tip, i) => (
            <details key={tip.title} className="token-tip">
              <summary className="token-tip-title">
                <span className="token-tip-title-text">
                  <span className="token-tip-index">{i + 1}.</span> {tip.title}
                </span>
              </summary>
              <p className="token-tip-body">{tip.body}</p>
            </details>
          ))}
        </div>
        <p className="link-dialog-hint">{t.tokenTipsHint}</p>
        <button type="button" className="link-dialog-close" onClick={onClose}>{t.dismiss}</button>
      </div>
    </div>
  );
};

/**
 * 语言偏好存在 localStorage 里，属于 React 之外的状态源，
 * 用 useSyncExternalStore 订阅：服务端快照固定为 'en'，客户端读实际值，
 * React 会在 hydration 后正确切换，不会出现「先英文再跳中文」的闪烁，
 * 也不会触发 hydration 不匹配告警。
 */
const LANG_KEY = 'ccusage-lang';
const langListeners = new Set();

function subscribeLang(cb) {
  langListeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    langListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function getLangSnapshot() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    return saved === 'zh' || saved === 'en' ? saved : 'en';
  } catch {
    // 隐私模式下 localStorage 访问会抛异常
    return 'en';
  }
}

const getLangServerSnapshot = () => 'en';

function setStoredLang(next) {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* 同上，存不进去也不影响本次会话 */
  }
  langListeners.forEach((cb) => cb());
}

/**
 * 当前查看的数据源（Claude Code / Codex），同样存在 localStorage 里，
 * 用同一套 useSyncExternalStore 模式避免 hydration 闪烁。
 */
const PROVIDER_KEY = 'ccusage-provider';
const providerListeners = new Set();

function subscribeProvider(cb) {
  providerListeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    providerListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function getProviderSnapshot() {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return PROVIDERS[saved] ? saved : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

const getProviderServerSnapshot = () => DEFAULT_PROVIDER;

function setStoredProvider(next) {
  try {
    localStorage.setItem(PROVIDER_KEY, next);
  } catch {
    /* 隐私模式下存不进去，本次会话内仍然生效 */
  }
  providerListeners.forEach((cb) => cb());
}

/**
 * 成本口径提示条的显隐，同样存在 localStorage。
 *
 * 这条说明第一次看很重要（订阅制用户不按 token 付费），但看过之后每次都占一行
 * 就变成噪音了，所以做成可关闭 + 记住选择，并在总成本卡片上留一个重新打开的入口。
 */
const COST_NOTE_KEY = 'ccusage-cost-note-dismissed';
const costNoteListeners = new Set();

function subscribeCostNote(cb) {
  costNoteListeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    costNoteListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function getCostNoteSnapshot() {
  try {
    return localStorage.getItem(COST_NOTE_KEY) !== '1';
  } catch {
    return true;
  }
}

const getCostNoteServerSnapshot = () => true;

function setCostNoteVisible(visible) {
  try {
    if (visible) localStorage.removeItem(COST_NOTE_KEY);
    else localStorage.setItem(COST_NOTE_KEY, '1');
  } catch {
    /* 隐私模式下写不进去，本次会话内仍然生效 */
  }
  costNoteListeners.forEach((cb) => cb());
}

/**
 * 顶部数据源切换开关：Claude Code / Codex 各自的数据、缓存、Rust 命令
 * 全部独立，这里切换只是换一套 provider 传给 UsageDashboard，
 * 靠 key 强制重新挂载，两边状态不会串。
 */
const ProviderSwitch = ({ activeKey, onChange, t }) => (
  <div className="provider-switch" role="tablist" aria-label={t.dataSource}>
    {PROVIDER_ORDER.map((key) => (
      <button
        key={key}
        type="button"
        role="tab"
        aria-selected={activeKey === key}
        className={`provider-switch-btn ${activeKey === key ? 'active' : ''}`}
        onClick={() => onChange(key)}
      >
        {PROVIDERS[key].label}
      </button>
    ))}
  </div>
);

const ModelTags = ({ models }) => (
  <div className="model-tags-wrapper">
    {(models || []).map((m) => (
      <span key={m} className="model-tag" title={m}>{m}</span>
    ))}
  </div>
);

/**
 * 单个数据源的看板主体。provider 提供 readCache/refreshUsage/getTurnsForConversation
 * 三个函数，UI 逻辑对两边一视同仁 —— 概念已经在各自的 parser 里对齐好了。
 *
 * 标题栏（语言/时间范围/刷新）和数据源切换条是全应用共享的一份，活在外层的
 * Page 组件里；这里只管一个数据源自己的下钻状态和表格渲染。data/loading/error
 * 也由 Page 统一拉取并作为 props 传入，这样"刷新"天然会同时刷新两边，时间范围/
 * 语言这些设置也天然共享，不会因为切换数据源而重置或各算各的。
 */
function UsageDashboard({ provider, data, loading, error, t, locale, dateRange, onDataChange }) {
  const lang = locale === 'zh-CN' ? 'zh' : 'en';

  const costNoteVisible = useSyncExternalStore(
    subscribeCostNote, getCostNoteSnapshot, getCostNoteServerSnapshot
  );
  const dismissCostNote = () => setCostNoteVisible(false);
  const showCostNote = () => setCostNoteVisible(true);

  const [pricingDialogOpen, setPricingDialogOpen] = useState(false);
  const [tokenTipsDialogOpen, setTokenTipsDialogOpen] = useState(false);

  const [activeTab, setActiveTab] = useState('daily');

  // 下钻筛选条件。这些条件是**可叠加**的：同时挂着项目和日期时两者都要生效，
  // 旧实现用 else-if 串联，UI 上显示两个筛选气泡但实际只有一个起作用。
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  /**
   * 交互明细的作用对象，**独立于列表筛选**。
   *
   * 早先是把 conversation / session 塞进筛选状态来实现下钻的，副作用是：
   * 返回对话列表时列表被意外筛成了那个会话，还留着一个删不掉的对话气泡。
   * 明细页只是「某一条对话的详情」，它不该改动上一层的筛选。
   */
  const [turnsTarget, setTurnsTarget] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);

  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);

  // 时间范围现在是全应用共享的一份状态（见 Page），这里只负责在它变化时
  // 把自己的分页重置掉，和原来下拉框 onChange 里做的事一致。在渲染期间比较
  // 而不是用 effect：这是 React 推荐的"按 prop 变化调整 state"写法，
  // 避免在 effect 里同步 setState 引发多一轮级联渲染。
  const [prevDateRange, setPrevDateRange] = useState(dateRange);
  if (dateRange !== prevDateRange) {
    setPrevDateRange(dateRange);
    setVisibleRows(PAGE_SIZE);
  }

  // turn 明细按 {查询键 -> 行} 缓存，避免用 setState(null) 去重置，
  // 也让切回同一条对话时不必重新请求。
  const [turnsCache, setTurnsCache] = useState({ key: null, rows: [] });

  // 待确认的移除对象；null 表示不弹框。数据源不支持移除时不显示移除按钮。
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const canRemove = typeof provider.removeFromStats === 'function';

  /**
   * 这个会话的历史是否被 resume 复制进了日志仍在的会话。是的话，删除后那部分会改算到
   * 那个会话名下，总额减少得会比这一行少 —— 提前在确认框里说清楚。
   */
  const historyLivesOn = (sessionId) => (data?.sessions || []).some(
    (s) => !s.sourceDeleted && (s.inheritedFrom || []).includes(sessionId)
  );

  const askRemove = (target) => {
    setRemoveError(null);
    setRemoveTarget(target);
  };

  const cancelRemove = () => {
    if (!removing) setRemoveTarget(null);
  };

  const confirmRemove = async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const next = await provider.removeFromStats(
        removeTarget.kind === 'session' ? { sessionId: removeTarget.id } : { conversationId: removeTarget.id }
      );
      // 被移除的会话要是正挂在筛选上，筛选一起清掉，否则列表会停在一个已经不存在的会话上。
      if (removeTarget.kind === 'session' && selectedSession === removeTarget.id) setSelectedSession(null);
      onDataChange(toPayload(next));
      setRemoveTarget(null);
    } catch (err) {
      setRemoveError(err && err.message ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  /** 当前 turns 查询键；为 null 表示这一屏不需要 turn 明细。 */
  const turnsKey = useMemo(() => {
    if (activeTab !== 'turns') return null;
    if (!turnsTarget) return null;
    return `conversationId=${encodeURIComponent(turnsTarget.id)}`;
  }, [activeTab, turnsTarget]);

  // turn 明细按需拉取：它占总数据量九成以上，且只在下钻时才需要。
  useEffect(() => {
    if (!turnsKey || !turnsTarget) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const turns = await provider.getTurnsForConversation(turnsTarget.id);
        if (!cancelled) setTurnsCache({ key: turnsKey, rows: turns || [] });
      } catch {
        if (!cancelled) setTurnsCache({ key: turnsKey, rows: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [turnsKey, turnsTarget, provider]);

  const turns = turnsCache.key === turnsKey ? turnsCache.rows : null;
  const turnsLoading = !!turnsKey && turns === null;

  const requestSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
    setVisibleRows(PAGE_SIZE);
  };

  const goTo = useCallback((tab, patch = {}) => {
    if ('project' in patch) setSelectedProject(patch.project);
    if ('session' in patch) setSelectedSession(patch.session);
    if ('date' in patch) setSelectedDate(patch.date);
    setActiveTab(tab);
    setSortConfig({ key: 'date', direction: 'desc' });
    setVisibleRows(PAGE_SIZE);
  }, []);

  /** 打开某条对话的交互明细。只影响明细页自己的作用域。 */
  const openTurns = useCallback((conv) => {
    setTurnsTarget({ id: conv.id, sessionId: conv.sessionId, label: conv.prompt, date: conv.date });
    setActiveTab('turns');
    setSortConfig({ key: 'date', direction: 'desc' });
    setVisibleRows(PAGE_SIZE);
  }, []);

  /** 关闭明细，回到对话列表 —— 列表的筛选状态原样保留。 */
  const closeTurns = useCallback(() => {
    setActiveTab('conversations');
    setVisibleRows(PAGE_SIZE);
  }, []);

  const clearAllFilters = () => {
    setSelectedProject(null);
    setSelectedSession(null);
    setSelectedDate(null);
    setVisibleRows(PAGE_SIZE);
  };

  /** 时间范围下限（本地日字符串），用于图表和列表的统一过滤。 */
  const rangeFloor = useMemo(() => {
    if (dateRange === 'all') return null;
    const days = dateRange === '7d' ? 7 : 30;
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [dateRange]);

  const localDay = useCallback((iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const daily = useMemo(() => {
    const rows = data?.daily || [];
    return rangeFloor ? rows.filter((d) => d.date >= rangeFloor) : rows;
  }, [data, rangeFloor]);

  /**
   * 当前时间范围内的分类汇总。
   *
   * 从 daily 累加而不是直接用 summary：这样「近 7 天 / 近 30 天」筛选能同时作用在
   * 用量成本对比图上，不会出现图表和上面的时间范围对不上的情况。
   */
  const rangeTotals = useMemo(() => {
    const acc = {
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1h: 0,
      cacheReadTokens: 0, totalTokens: 0,
      costInput: 0, costOutput: 0, costCacheWrite: 0, costCacheRead: 0, cost: 0,
    };
    for (const d of daily) for (const k of Object.keys(acc)) acc[k] += d[k] || 0;
    return acc;
  }, [daily]);

  /** 图表数据独立成 memo，避免每次渲染都重建数组、导致 recharts 全量重绘。 */
  const chartData = useMemo(
    () => daily.map((d) => ({
      date: d.date,
      cost: Number((d.totalCost || 0).toFixed(4)),
      inputTokens: d.inputTokens || 0,
      outputTokens: d.outputTokens || 0,
      cacheTokens: d.cacheTokens || 0,
    })),
    [daily]
  );

  const sortRows = useCallback((list) => {
    const { key, direction } = sortConfig;
    const dir = direction === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      let av;
      let bv;
      if (key === 'date') {
        av = new Date(a.date || a.timestamp || 0).getTime();
        bv = new Date(b.date || b.timestamp || 0).getTime();
      } else if (key === 'cost') {
        av = a.cost ?? a.totalCost ?? 0;
        bv = b.cost ?? b.totalCost ?? 0;
      } else {
        av = a[key];
        bv = b[key];
      }
      if (av == null) av = typeof bv === 'number' ? 0 : '';
      if (bv == null) bv = typeof av === 'number' ? 0 : '';
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv), locale) * dir;
      }
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [sortConfig, locale]);

  const sortedDaily = useMemo(() => sortRows(daily), [daily, sortRows]);
  const sortedProjects = useMemo(() => sortRows(data?.projects || []), [data, sortRows]);

  // 筛选条件叠加生效（项目 AND 会话 AND 日期），而不是只取其中一个。
  const filteredSessions = useMemo(() => {
    let rows = data?.sessions || [];
    if (selectedProject) rows = rows.filter((s) => s.projectKey === selectedProject);
    if (selectedDate) rows = rows.filter((s) => localDay(s.date) === selectedDate);
    else if (rangeFloor) rows = rows.filter((s) => (localDay(s.date) || '') >= rangeFloor);
    return sortRows(rows);
  }, [data, selectedProject, selectedDate, rangeFloor, sortRows, localDay]);

  const filteredConversations = useMemo(() => {
    let rows = data?.conversations || [];
    if (selectedProject) rows = rows.filter((c) => c.projectKey === selectedProject);
    // 一次提问可能被 resume 打断、跨两个会话完成（parser 会把它合成一条，
    // 归给 turn 更多的那边）。按 shards 一起匹配，另一边点进来才不会是空的。
    if (selectedSession) {
      rows = rows.filter(
        (c) => c.sessionId === selectedSession || (c.shards && c.shards.includes(selectedSession))
      );
    }
    if (selectedDate) rows = rows.filter((c) => localDay(c.date) === selectedDate);
    else if (rangeFloor) rows = rows.filter((c) => (localDay(c.date) || '') >= rangeFloor);
    return sortRows(rows);
  }, [data, selectedProject, selectedSession, selectedDate, rangeFloor, sortRows, localDay]);

  const sortedTurns = useMemo(() => sortRows(turns || []), [turns, sortRows]);
  // 额度读数只有 Codex 订阅套餐的日志才有，没有的话整列不出现。
  const showQuotaCol = sortedTurns.some((r) => r.quotaPct != null);
  const turnsColSpan = showQuotaCol ? 9 : 8;

  /**
   * Codex 有一批对话没打开过具体目录（home 目录下，或桌面版自己建的临时工作区），
   * cwd 的最后一段是没有意义的随机短名，不能直接当项目名展示——统一显示成
   * "未分类"，而不是让用户看到一堆自己从没见过、在 Codex 里也找不到的项目。
   * provider.unassignedProjectKey 对 Claude Code 是 undefined，下面的比较天然不命中。
   */
  const isUnassignedProject = useCallback(
    (key) => !!provider.unassignedProjectKey && key === provider.unassignedProjectKey,
    [provider]
  );
  const displayProjectName = useCallback(
    (row) => (isUnassignedProject(row.projectKey) ? t.unassignedProject : row.projectName),
    [isUnassignedProject, t]
  );

  const projectNameOf = useCallback((key) => {
    if (isUnassignedProject(key)) return t.unassignedProject;
    return (data?.projects || []).find((p) => p.projectKey === key)?.projectName || key;
  }, [data, isUnassignedProject, t]);

  const SortHeader = ({ label, sortKey, align, width }) => {
    const active = sortConfig.key === sortKey;
    const Icon = !active ? ChevronsUpDown : sortConfig.direction === 'asc' ? ChevronUp : ChevronDown;
    return (
      <th
        style={{ width, textAlign: align, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => requestSort(sortKey)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); requestSort(sortKey); } }}
        tabIndex={0}
        role="columnheader"
        aria-sort={active ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon
          size={14}
          style={{
            display: 'inline', marginLeft: 4, verticalAlign: '-2px',
            color: active ? 'var(--indigo-600)' : 'var(--gray-400)',
          }}
        />
      </th>
    );
  };

  const TableFooter = ({ total, colSpan }) => {
    if (total <= visibleRows) return null;
    return (
      <tr>
        <td colSpan={colSpan} style={{ textAlign: 'center', padding: '16px' }}>
          <span style={{ color: 'var(--gray-500)', fontSize: '0.85rem', marginRight: '12px' }}>
            {t.showing} {visibleRows} {t.of} {total} {t.rows}
          </span>
          <button className="drill-btn" onClick={() => setVisibleRows((v) => v + PAGE_SIZE)}>
            {t.showMore}
          </button>
        </td>
      </tr>
    );
  };

  const EmptyRow = ({ colSpan, label }) => (
    <tr><td colSpan={colSpan} className="text-center" style={{ padding: '24px' }}>{label}</td></tr>
  );

  const FilterBubbles = () => {
    const bubbles = [];
    if (selectedProject) {
      bubbles.push({ k: 'p', label: `${t.project}: ${projectNameOf(selectedProject)}`, clear: () => setSelectedProject(null) });
    }
    if (selectedSession) {
      bubbles.push({ k: 's', label: `${t.session}: ${shortSessionId(selectedSession)}`, clear: () => setSelectedSession(null) });
    }
    if (selectedDate) {
      bubbles.push({ k: 'd', label: `${t.date}: ${selectedDate}`, clear: () => setSelectedDate(null) });
    }
    if (!bubbles.length) return null;
    return (
      <>
        {bubbles.map((b) => (
          <span key={b.k} className="filter-bubble">
            {b.label}
            <X size={14} className="filter-bubble-close" onClick={b.clear} />
          </span>
        ))}
        {bubbles.length > 1 && (
          <button className="back-btn" style={{ marginLeft: 8 }} onClick={clearAllFilters}>
            {t.clearFilters}
          </button>
        )}
      </>
    );
  };

  if (loading && !data) {
    return (
      <div className="center-container">
        <div className="spinner" />
        <p style={{ marginTop: '16px', color: 'var(--gray-500)' }}>{t.loading}</p>
      </div>
    );
  }

  if (error) {
    // 「去哪儿反馈」的入口现在是标题栏里那个一直显示的 GitHub 按钮（见 Page），
    // 不用在这里再挂一份——以前它是出错时唯一还能点的东西，现在标题栏任何时候都在。
    return (
      <div className="center-container">
        <div className="error-card">
          <AlertCircle size={24} />
          <div><h3>{t.errorLoading}</h3><p>{error}</p></div>
        </div>
      </div>
    );
  }

  const summary = data.summary || {};

  const renderDailyTab = () => (
    <>
      <div className="charts-grid">
        <div className="card chart-container">
          <h3 className="section-title"><Activity className="text-indigo" size={20} /> {t.dailyCostTrend}</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" fontSize={12} tickMargin={10} minTickGap={24} />
                <YAxis stroke="#9ca3af" fontSize={12} tickFormatter={(v) => `$${v}`} />
                <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} formatter={(v) => [`$${v}`, t.cost]} />
                <Line type="monotone" dataKey="cost" stroke="#6366f1" strokeWidth={3} dot={chartData.length <= 60 ? { r: 4, strokeWidth: 2 } : false} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card chart-container">
          <h3 className="section-title"><BarChart3 className="text-blue" size={20} /> {t.volumeVsCost}</h3>
          <VolumeVsCost totals={rangeTotals} t={t} locale={locale} />
        </div>
      </div>
      <div className="card">
        <h3 className="section-title">{t.dailyUsageLog}</h3>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label={t.date} sortKey="date" />
                <th>{t.agentsModels}</th>
                <SortHeader label={t.conversations} sortKey="conversationCount" align="right" />
                <SortHeader label={t.cost} sortKey="totalCost" align="right" />
                <th className="text-right">{t.costPerConv}</th>
                <SortHeader label={t.input} sortKey="inputTokens" align="right" />
                <SortHeader label={t.output} sortKey="outputTokens" align="right" />
                <SortHeader label={t.totalTokens} sortKey="totalTokens" align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedDaily.slice(0, visibleRows).map((row) => (
                <tr key={row.date} className="hover-lift" style={{ cursor: 'pointer' }}
                  onClick={() => goTo('conversations', { date: row.date, project: null, session: null })}>
                  <td className="font-medium">{fmtDayLabel(row.date, locale)}</td>
                  <td><ModelTags models={row.models} /></td>
                  <td className="text-right">{row.conversationCount || 0}</td>
                  <td className="text-right text-indigo font-semibold">{fmtCost(row.totalCost)}</td>
                  <td className="text-right font-medium">{fmtCost(row.conversationCount ? row.totalCost / row.conversationCount : 0)}</td>
                  <td className="text-right">{fmtNum(row.inputTokens)}</td>
                  <td className="text-right">{fmtNum(row.outputTokens)}</td>
                  <td className="text-right font-medium">{fmtNum(row.totalTokens)}</td>
                </tr>
              ))}
              {!sortedDaily.length && <EmptyRow colSpan={8} label={t.noConversations} />}
              <TableFooter total={sortedDaily.length} colSpan={8} />
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  const renderProjectsTab = () => (
    <>
      <div className="card">
        <h3 className="section-title">{t.project}</h3>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label={t.project} sortKey="projectName" width="22%" />
                <SortHeader label={t.date} sortKey="firstActivity" width="90px" />
                <th>{t.agentsModels}</th>
                <SortHeader label={t.sessions} sortKey="sessionCount" width="90px" align="center" />
                <SortHeader label={t.convsShort} sortKey="conversationCount" width="80px" align="center" />
                <SortHeader label={t.cost} sortKey="totalCost" width="90px" align="right" />
                <th style={{ width: '80px' }} className="text-right">{t.costPerConv}</th>
                <SortHeader label={t.totalTokens} sortKey="totalTokens" width="100px" align="right" />
                <th style={{ width: '90px' }} className="text-right">{t.action}</th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.slice(0, visibleRows).map((row) => (
                <tr key={row.projectKey}>
                  <td>
                    <div className="font-semibold text-gray-800" style={{ wordBreak: 'break-all' }}
                      title={isUnassignedProject(row.projectKey) ? t.unassignedProjectTip : row.projectKey}>
                      {displayProjectName(row)}
                    </div>
                  </td>
                  <td className="ts-cell text-gray-500 font-medium text-xs">{fmtDateOnly(row.firstActivity)}</td>
                  <td><ModelTags models={row.models} /></td>
                  <td className="text-center">{row.sessionCount}</td>
                  <td className="text-center">{row.conversationCount || 0}</td>
                  <td className="text-right text-indigo font-semibold">{fmtCost(row.totalCost)}</td>
                  <td className="text-right font-medium">{fmtCost(row.conversationCount ? row.totalCost / row.conversationCount : 0)}</td>
                  <td className="text-right font-medium">{fmtNum(row.totalTokens)}</td>
                  <td className="text-right">
                    <button className="drill-btn" onClick={() => goTo('sessions', { project: row.projectKey, session: null, date: null })}>
                      {t.sessions} <ChevronRight size={13} />
                    </button>
                  </td>
                </tr>
              ))}
              {!sortedProjects.length && <EmptyRow colSpan={9} label={t.noProjects} />}
              <TableFooter total={sortedProjects.length} colSpan={9} />
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  const renderSessionsTab = () => (
    <div className="card">
      <div className="card-header-flex">
        <h3 className="section-title" style={{ margin: 0 }}>
          <MessageSquare className="text-indigo" size={20} />
          {t.sessions}
          <FilterBubbles />
        </h3>
        {selectedProject && (
          <button className="back-btn" onClick={() => setActiveTab('projects')}><ArrowLeft size={16} /> {t.backToProjects}</button>
        )}
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader label={t.time} sortKey="date" width="120px" />
              {!selectedProject && <SortHeader label={t.project} sortKey="projectName" width="15%" />}
              <SortHeader label={t.session} sortKey="sessionName" width="15%" />
              <th>{t.agentsModels}</th>
              <SortHeader label={t.turnsCount} sortKey="turnCount" width="70px" align="center" />
              <SortHeader label={t.totalTokens} sortKey="totalTokens" width="100px" align="right" />
              <SortHeader label={t.cost} sortKey="cost" width="90px" align="right" />
              <th style={{ width: canRemove ? '128px' : '90px' }} className="text-right">{t.action}</th>
            </tr>
          </thead>
          <tbody>
            {filteredSessions.slice(0, visibleRows).map((row) => (
              <tr key={row.sessionId}>
                <td className="ts-cell font-medium">{fmtDate(row.date)}</td>
                {!selectedProject && (
                  <td>
                    <div className="font-semibold text-gray-800" style={{ wordBreak: 'break-all' }}
                      title={isUnassignedProject(row.projectKey) ? t.unassignedProjectTip : row.projectKey}>
                      {displayProjectName(row)}
                    </div>
                  </td>
                )}
                <td>
                  <div style={{ fontWeight: '500', color: 'var(--gray-800)' }}>
                    {row.sessionName || t.unnamedSession}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)' }}>{shortSessionId(row.sessionId)}...</div>
                  {row.replayOnly && (
                    <span className="replay-badge" title={t.replayOnlyTip}>
                      {t.replayOnly} · {row.inheritedTurns}
                    </span>
                  )}
                  {row.sourceDeleted && (
                    <span className="source-deleted-badge" title={t.sourceDeletedTip}>{t.sourceDeleted}</span>
                  )}
                </td>
                <td><ModelTags models={row.models} /></td>
                <td className="text-center">{row.turnCount}</td>
                <td className="text-right font-medium">{fmtNum(row.totalTokens)}</td>
                <td className="text-right text-indigo font-semibold">{fmtCost(row.cost)}</td>
                <td className="text-right">
                  <div className="row-actions">
                    <button className="drill-btn" onClick={() => goTo('conversations', { session: row.sessionId })}>
                      {t.conversations} <ChevronRight size={13} />
                    </button>
                    {canRemove && row.sourceDeleted && (
                      <button type="button" className="row-remove-btn" title={t.removeFromStats} aria-label={t.removeFromStats}
                        onClick={() => askRemove({
                          kind: 'session',
                          id: row.sessionId,
                          label: row.sessionName || t.unnamedSession,
                          cost: row.cost,
                          tokens: row.totalTokens,
                          sharedHistory: historyLivesOn(row.sessionId),
                        })}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!filteredSessions.length && <EmptyRow colSpan={selectedProject ? 7 : 8} label={t.noSessions} />}
            <TableFooter total={filteredSessions.length} colSpan={selectedProject ? 7 : 8} />
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderConversationsTab = () => (
    <div className="card">
      <div className="card-header-flex">
        <h3 className="section-title" style={{ margin: 0 }}>
          <AlignLeft className="text-indigo" size={20} />
          {t.conversations}
          <FilterBubbles />
        </h3>
        {selectedSession ? (
          <button className="back-btn" onClick={() => setActiveTab('sessions')}><ArrowLeft size={16} /> {t.backToSessions}</button>
        ) : selectedProject ? (
          <button className="back-btn" onClick={() => setActiveTab('projects')}><ArrowLeft size={16} /> {t.backToProjects}</button>
        ) : selectedDate ? (
          <button className="back-btn" onClick={() => setActiveTab('daily')}><ArrowLeft size={16} /> {t.backToDailyTrends}</button>
        ) : null}
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader label={t.time} sortKey="date" width="80px" />
              <SortHeader label={t.project} sortKey="projectName" width="12%" />
              <SortHeader label={t.session} sortKey="sessionName" width="12%" />
              <th>{t.userPrompt}</th>
              <SortHeader label={t.turns} sortKey="turnCount" width="60px" align="center" />
              <th style={{ width: '140px' }}>{t.model}</th>
              <SortHeader label={t.totalTokens} sortKey="totalTokens" width="80px" align="right" />
              <SortHeader label={t.cost} sortKey="cost" width="75px" align="right" />
              <th style={{ width: canRemove ? '115px' : '75px' }} className="text-right">{t.action}</th>
            </tr>
          </thead>
          <tbody>
            {filteredConversations.slice(0, visibleRows).map((row) => (
              <tr key={row.id}>
                <td className="ts-cell font-medium">{fmtDate(row.date)}</td>
                <td className="text-xs">
                  <div className="font-semibold text-gray-800" style={{ wordBreak: 'break-all' }}
                    title={isUnassignedProject(row.projectKey) ? t.unassignedProjectTip : row.projectKey}>
                    {displayProjectName(row)}
                  </div>
                </td>
                <td className="text-xs">
                  <div title={row.sessionName || row.sessionId} className="font-medium text-gray-700" style={{ wordBreak: 'break-all' }}>
                    {row.sessionName || t.unnamedSession}
                  </div>
                  <div className="text-gray-400" style={{ fontSize: '10px' }}>{shortSessionId(row.sessionId)}</div>
                  {row.sourceDeleted && (
                    <span className="source-deleted-badge" title={t.sourceDeletedTip}>{t.sourceDeleted}</span>
                  )}
                </td>
                <td>
                  {row.kind === 'command' && (
                    <span className="command-badge" title={t.commandTip}>{t.command}</span>
                  )}
                  {provider.internalCheckKind && row.kind === provider.internalCheckKind && (
                    <span className="notification-badge" title={t.internalCheckTip}>{t.internalCheck}</span>
                  )}
                  {row.isGoalMode && (
                    <span className="goal-mode-badge" title={t.goalModeTip}>{t.goalMode}</span>
                  )}
                  <ExpandablePrompt prompt={row.prompt} t={t} />
                  {row.compaction && (
                    <div className="compaction-note" title={t.compactTip}>
                      {t.compacted}: {fmtNum(row.compaction.preTokens)} → {fmtNum(row.compaction.postTokens)}
                    </div>
                  )}
                </td>
                <td className="text-center">{row.turnCount}</td>
                <td><ModelTags models={row.models} /></td>
                <td className="text-right font-medium">{fmtNum(row.totalTokens)}</td>
                <td className="text-right text-indigo font-semibold">
                  {row.compaction && !row.cost
                    ? <span className="cost-unlogged" title={t.compactTip}>{t.costNotLogged}</span>
                    : fmtCost(row.cost)}
                  {row.quotaPct != null && (
                    <div className="quota-sub" title={t.quotaShareTip.replace('{pct}', fmtQuotaPct(row.quotaPct))}>
                      {fmtQuotaPct(row.quotaPct)}
                    </div>
                  )}
                </td>
                <td className="text-right">
                  <div className="row-actions">
                    <button className="drill-btn" onClick={() => openTurns(row)}>
                      {t.turns} <ChevronRight size={13} />
                    </button>
                    {canRemove && row.sourceDeleted && (
                      <button type="button" className="row-remove-btn" title={t.removeFromStats} aria-label={t.removeFromStats}
                        onClick={() => askRemove({
                          kind: 'conversation',
                          id: row.id,
                          label: row.prompt || fmtDateOnly(row.date),
                          cost: row.cost,
                          tokens: row.totalTokens,
                          sharedHistory: historyLivesOn(row.sessionId),
                        })}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!filteredConversations.length && <EmptyRow colSpan={9} label={t.noConversations} />}
            <TableFooter total={filteredConversations.length} colSpan={9} />
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderTurnsTab = () => (
    <div className="card">
      <div className="card-header-flex">
        <h3 className="section-title" style={{ margin: 0 }}>
          <TerminalSquare className="text-indigo" size={20} />
          {t.turns}
        </h3>
        <button className="back-btn" onClick={closeTurns}>
          <ArrowLeft size={16} /> {t.backToConversations}
        </button>
      </div>
      {/* 明细页不放筛选器，只说明「正在看哪一条」。筛选属于列表层，
          在这里放可删除的筛选气泡会让人以为能在明细里换对象，返回时也会污染列表状态。 */}
      {turnsTarget && (
        <div className="turns-context">
          <span className="turns-context-label">{t.conversation}</span>
          <span className="turns-context-prompt">{turnsTarget.label || t.unnamedSession}</span>
          <span className="turns-context-meta">{fmtDateOnly(turnsTarget.date)}</span>
        </div>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader label={t.time} sortKey="timestamp" />
              <SortHeader label={t.model} sortKey="model" />
              <SortHeader label={t.input} sortKey="inputTokens" align="right" />
              <SortHeader label={t.output} sortKey="outputTokens" align="right" />
              <SortHeader label={t.cacheWrite} sortKey="cacheWriteTokens" align="right" />
              <SortHeader label={t.cacheRead} sortKey="cacheReadTokens" align="right" />
              <SortHeader label={t.totalTokens} sortKey="totalTokens" align="right" />
              <SortHeader label={t.cost} sortKey="cost" align="right" />
              {showQuotaCol && <th style={{ textAlign: 'left', cursor: 'help' }} title={t.quotaLeftTip}>{t.quotaLeft}</th>}
            </tr>
          </thead>
          <tbody>
            {turnsLoading && <EmptyRow colSpan={turnsColSpan} label={t.loadingTurns} />}
            {!turnsLoading && sortedTurns.slice(0, visibleRows).map((row) => (
              <tr key={row.id}>
                <td className="ts-cell font-medium">{fmtDate(row.timestamp)}</td>
                <td>
                  <span className="model-tag">{row.model}</span>
                  {row.speed === 'fast' && <span className="model-tag" style={{ marginLeft: 4 }}>fast</span>}
                  {row.trigger && (
                    <div className="turn-trigger" title={t.triggeredByTip}>
                      <span className="notification-badge">{t.triggeredBy}</span>
                      <span className="turn-trigger-text">{row.trigger}</span>
                    </div>
                  )}
                  {row.subagent && (
                    <div className="turn-trigger" title={t.subagentTip}>
                      <span className="subagent-badge">{t.subagent}</span>
                      {row.agent && <span className="turn-trigger-text">{row.agent}</span>}
                    </div>
                  )}
                </td>
                <td className="text-right">{fmtNum(row.inputTokens)}</td>
                <td className="text-right text-green-600">{fmtNum(row.outputTokens)}</td>
                <td className="text-right text-purple-600">{fmtNum(row.cacheWriteTokens)}</td>
                <td className="text-right text-purple-600">{fmtNum(row.cacheReadTokens)}</td>
                <td className="text-right font-medium">{fmtNum(row.totalTokens)}</td>
                <td className="text-right text-indigo font-semibold">{fmtCost(row.cost, 5)}</td>
                {showQuotaCol && (
                  <td>
                    {row.quotaPct != null && (
                      <div className="quota-left">
                        <span>{t.quota5h}</span>
                        <span>{fmtQuotaLeft(row.quotaPct)}</span>
                        <span>{t.quotaWeek}</span>
                        <span>{fmtQuotaLeft(row.quotaWeekly)}</span>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!turnsLoading && !sortedTurns.length && <EmptyRow colSpan={turnsColSpan} label={t.noTurns} />}
            {!turnsLoading && <TableFooter total={sortedTurns.length} colSpan={turnsColSpan} />}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="dashboard-container">
      {/* 成本口径说明：订阅制用户并不按 token 付费，必须讲清楚这个数字代表什么。
          这是一次性提示，看过就能关掉；关掉后仍可从总成本卡片上的图标重新打开。 */}
      {costNoteVisible ? (
        <div className="cost-basis-note">
          <Info size={16} />
          <div>
            <strong>{t.costBasisTitle}</strong>
            <span>{t.costBasisBody.replace('{plan}', provider.plan)}</span>
            {summary.estimatedPricing && <em> · {t.estimatedPricing}</em>}
          </div>
          <button className="cost-basis-close" onClick={dismissCostNote} aria-label={t.dismiss} title={t.dismiss}>
            <X size={15} />
          </button>
        </div>
      ) : null}

      <div className="summary-grid">
        <StatCard
          icon={<DollarSign size={22} />}
          tone="indigo"
          title={
            <>
              {t.totalCost}
              {!costNoteVisible && (
                <button className="stat-info-btn" onClick={showCostNote}
                  aria-label={t.showCostBasis} title={t.showCostBasis}>
                  <Info size={13} />
                </button>
              )}
            </>
          }
          value={`$${(summary.totalCost || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          compact={fmtCostCompact(summary.totalCost, locale)}
        />
        <StatCard icon={<Cpu size={22} />} tone="blue" title={t.totalTokens}
          value={fmtNum(summary.totalTokens)} compact={fmtCompact(summary.totalTokens, locale)} />
        <StatCard icon={<Calendar size={22} />} tone="green" title={t.activeDays}
          value={String(summary.activeDays || 0)} />
        <StatCard icon={<FolderOpen size={22} />} tone="indigo" title={t.projects}
          value={String(summary.projectCount || 0)} />
        <StatCard icon={<MessageSquare size={22} />} tone="blue" title={t.sessions}
          value={String(summary.sessionCount || 0)} />
        <StatCard icon={<AlignLeft size={22} />} tone="green" title={t.conversations}
          value={fmtNum(summary.conversationCount)} compact={fmtCompact(summary.conversationCount, locale)} />
      </div>

      <div className="tabs-row">
        <div className="tabs-container">
          <button className={`tab-btn ${activeTab === 'daily' ? 'active' : ''}`} onClick={() => { setActiveTab('daily'); setVisibleRows(PAGE_SIZE); }}>
            <Activity size={18} /> {t.dailyTrends}
          </button>
          <button className={`tab-btn ${activeTab === 'projects' ? 'active' : ''}`} onClick={() => { setActiveTab('projects'); setVisibleRows(PAGE_SIZE); }}>
            <FolderOpen size={18} /> {t.projects}
          </button>
          <button className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`} onClick={() => { setActiveTab('sessions'); setVisibleRows(PAGE_SIZE); }}>
            <MessageSquare size={18} /> {t.sessions}
          </button>
          <button className={`tab-btn ${activeTab === 'conversations' ? 'active' : ''}`} onClick={() => { setActiveTab('conversations'); setVisibleRows(PAGE_SIZE); }}>
            <AlignLeft size={18} /> {t.conversations}
          </button>
          {activeTab === 'turns' && (
            <button className="tab-btn active"><TerminalSquare size={18} /> {t.turns}</button>
          )}
        </div>
        {/* 价目表和省 token 技巧这两个弹窗都跟 activeTab 无关，放在 tab 行最右侧，不管当前在
            哪个 tab 下都能点开 —— 挂在某个具体 tab 页面内容里的话，切到其他 tab 就找不到了。 */}
        <div className="tabs-row-actions">
          <button type="button" className="pricing-tab-btn" onClick={() => setTokenTipsDialogOpen(true)}
            aria-label={`${provider.label} ${t.showTokenTips}`} title={`${provider.label} ${t.showTokenTips}`}>
            <Lightbulb size={16} /> {provider.label} {t.tokenTipsTab}
          </button>
          <button type="button" className="pricing-tab-btn" onClick={() => setPricingDialogOpen(true)}
            aria-label={`${provider.label} ${t.showPricingTable}`} title={`${provider.label} ${t.showPricingTable}`}>
            <Receipt size={16} /> {provider.label} {t.pricingTab}
          </button>
        </div>
      </div>

      {activeTab === 'daily' && renderDailyTab()}
      {activeTab === 'projects' && renderProjectsTab()}
      {activeTab === 'sessions' && renderSessionsTab()}
      {activeTab === 'conversations' && renderConversationsTab()}
      {activeTab === 'turns' && renderTurnsTab()}

      {data.stats && (
        <p className="footer-stats">
          {fmtNum(data.stats.linesParsed)} {t.parsedLines}
          {' · '}{fmtNum(data.stats.duplicatesDropped)} {t.duplicatesDropped}
          {' · '}{t.refreshedIn} {data.stats.durationMs}ms
        </p>
      )}

      {removeTarget && (
        <RemoveDialog target={removeTarget} t={t} busy={removing} error={removeError}
          onCancel={cancelRemove} onConfirm={confirmRemove} />
      )}

      {pricingDialogOpen && (
        <PricingDialog provider={provider} t={t} onClose={() => setPricingDialogOpen(false)} />
      )}

      {tokenTipsDialogOpen && (
        <TokenTipsDialog provider={provider} t={t} lang={lang} onClose={() => setTokenTipsDialogOpen(false)} />
      )}
    </div>
  );
}

/**
 * 应用外壳：标题栏（标题/GitHub 入口/时间范围/语言/刷新）和数据源切换条
 * 只在这一层渲染一份，两个数据源共用。数据源切换条排在标题栏**之下**，
 * 是整个应用里的第二级导航，和下面「每日/项目/会话/对话」那一排 tab 同级，
 * 不再是挂在最顶上、切换时把标题栏也一起换掉的东西。
 *
 * 两个数据源的数据由这一层统一拉取和持有（loadProvider/providerState），
 * 和 DOM 里挂不挂载 UsageDashboard 无关，所以下面只挂载当前选中的那一个
 * 也不影响另一边在后台保持数据新鲜。这带来两个效果：
 *   1) 刷新按钮在标题栏，点一次会同时刷新 Claude Code 和 Codex（见
 *      handleRefreshAll），而不是只刷当前看到的那一个；
 *   2) 时间范围这类设置提到这一层做成共享状态，切换数据源不会被重置，
 *      也不用重新拉一遍缓存——两边的数据各自独立抓取、独立出错，
 *      一边报错不会连累另一边，仍然满足"数据分离"的要求。
 */
export default function Page() {
  const lang = useSyncExternalStore(subscribeLang, getLangSnapshot, getLangServerSnapshot);
  const t = i18n[lang];
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const toggleLang = () => setStoredLang(lang === 'en' ? 'zh' : 'en');

  const activeProvider = useSyncExternalStore(
    subscribeProvider, getProviderSnapshot, getProviderServerSnapshot
  );

  const [dateRange, setDateRange] = useState('all');

  const [providerState, setProviderState] = useState(() => {
    const init = {};
    for (const key of PROVIDER_ORDER) init[key] = { data: null, loading: true, error: null };
    return init;
  });
  const [refreshingAll, setRefreshingAll] = useState(false);

  /** 读取（或在缓存失效时重建）单个数据源，失败只记到它自己名下。 */
  const loadProvider = useCallback(async (key, { force = false } = {}) => {
    const provider = PROVIDERS[key];
    try {
      let cacheData;
      if (force) {
        cacheData = await provider.refreshUsage({ force: true });
      } else {
        const { cache, rebuildReason } = await provider.readCache();
        cacheData = rebuildReason ? await provider.refreshUsage({ force: true }) : cache;
      }
      setProviderState((prev) => ({ ...prev, [key]: { data: toPayload(cacheData), loading: false, error: null } }));
    } catch (err) {
      setProviderState((prev) => ({ ...prev, [key]: { data: prev[key].data, loading: false, error: err.message } }));
    }
  }, []);

  // 启动时两个数据源各自拉一次，互不等待、互不影响。
  useEffect(() => {
    PROVIDER_ORDER.forEach((key) => loadProvider(key));
  }, [loadProvider]);

  /** 标题栏那一个刷新按钮：同时强制重刷两边，各自独立成功/失败。 */
  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true);
    await Promise.all(PROVIDER_ORDER.map((key) => loadProvider(key, { force: true })));
    setRefreshingAll(false);
  }, [loadProvider]);

  /** 删除缓存记录这类操作改完数据后，把结果写回这一个数据源自己的状态。 */
  const updateProviderData = useCallback((key, payload) => {
    setProviderState((prev) => ({ ...prev, [key]: { ...prev[key], data: payload } }));
  }, []);

  // 唤不起浏览器时弹的说明框。null 表示不显示，copied 记录地址有没有进剪贴板。
  const [linkDialog, setLinkDialog] = useState(null);

  /** 桌面端的 WebView 会拦掉 window.open，外链只能交给系统浏览器。 */
  const openProjectPage = useCallback(async () => {
    try {
      await openUrl(PROJECT_URL);
      return;
    } catch {
      // 浏览器里跑 next dev 时没有 Tauri，退回普通新开标签页。
      if (typeof window !== 'undefined' && window.open(PROJECT_URL, '_blank', 'noopener')) return;
    }
    // 两条路都不通就把地址交到用户手上，别让这次点击无声无息地消失。
    let copied = false;
    try {
      await navigator.clipboard.writeText(PROJECT_URL);
      copied = true;
    } catch {
      copied = false;
    }
    setLinkDialog({ copied });
  }, []);

  const activeData = providerState[activeProvider].data;

  return (
    <div className="app-shell">
      <header className="dashboard-header">
        <div>
          <h1 className="header-title">
            <TerminalSquare className="icon-primary" size={32} /> {t.title}
            {/* 项目主页入口：显示 GitHub 图标、项目文案与外链指示 */}
            <button type="button" className="header-github" onClick={openProjectPage}
              aria-label={t.viewOnGithub} title={t.viewOnGithub}>
              <GithubIcon size={16} />
              <span className="header-github-label">{t.githubProject}</span>
              <ExternalLink size={12} className="header-github-ext" />
            </button>
          </h1>
          <p className="header-subtitle">
            {t.subtitle}
            {activeData?.generatedAt && (
              <span style={{ marginLeft: '12px', fontSize: '0.8rem', color: 'var(--gray-400)' }}>
                {t.lastUpdated} {new Date(activeData.generatedAt).toLocaleString(locale)}
              </span>
            )}
          </p>
        </div>
        <div className="header-controls">
          <DateRangeDropdown value={dateRange} onChange={setDateRange} t={t} />
          <button onClick={toggleLang} className="refresh-btn" style={{ background: 'var(--gray-100)', color: 'var(--gray-700)', borderColor: 'var(--gray-300)' }}>
            <Globe size={18} /> {lang === 'en' ? '中文' : 'EN'}
          </button>
          <button onClick={handleRefreshAll} className={`refresh-btn ${refreshingAll ? 'refreshing' : ''}`} disabled={refreshingAll}>
            <RefreshCw size={18} className={refreshingAll ? 'spin-icon' : ''} /> {refreshingAll ? t.syncing : t.refresh}
          </button>
          <ProviderSwitch activeKey={activeProvider} onChange={setStoredProvider} t={t} />
        </div>
      </header>

      {/*
        只挂载当前选中的那一个：两边的数据都由上面的 loadProvider/handleRefreshAll
        统一拉取和持有，不受这里挂不挂载影响，所以不需要为了"切换时不丢状态"把
        两个看板都常驻在 DOM 里——常驻反而会让不可见那一侧的 Recharts 图表在
        display:none 下量出 0×0 尺寸，切回来时不一定能正确重新测量。切换数据源时
        下钻筛选状态清空是合理的（本来就是完全不同的两份数据），和以前用 key
        强制重新挂载时的行为一致。
      */}
      {(() => {
        const state = providerState[activeProvider];
        return (
          <UsageDashboard
            key={activeProvider}
            provider={PROVIDERS[activeProvider]}
            data={state.data}
            loading={state.loading}
            error={state.error}
            t={t}
            locale={locale}
            dateRange={dateRange}
            onDataChange={(payload) => updateProviderData(activeProvider, payload)}
          />
        );
      })()}

      <footer className="app-footer">
        <span className="app-footer-meta">
          <span className="app-footer-name">{t.title}</span>
          {APP_VERSION && <span> v{APP_VERSION}</span>}
          <span> · {t.localOnlyNote}</span>
        </span>
      </footer>

      {linkDialog && (
        <ProjectLinkDialog copied={linkDialog.copied} t={t} onClose={() => setLinkDialog(null)} />
      )}
    </div>
  );
}
