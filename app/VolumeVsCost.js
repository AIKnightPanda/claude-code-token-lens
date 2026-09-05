"use client";

import { useMemo, useState } from 'react';

/**
 * 用量 vs 成本对比图。
 *
 * 左列是各类 token 占「用量」的比例，右列是占「成本」的比例，同类之间用色带相连。
 *
 * 之所以不用堆叠柱状图：这里要表达的是**错位**——缓存读取能占到 token 总量的
 * 97%，但单价只有输入价的 1/10，成本占比要小得多；反过来输出 token 数量微不足道，
 * 却是最贵的一档。两个 100% 归一化的列加上连接色带，能把「大块变小、细线变粗」
 * 这件事一眼画出来，而堆叠柱只能看出某一天用了多少，看不出钱花在哪。
 */

const BAR_TOP = 30;
const BAR_HEIGHT = 168;
const VIEW_W = 520;
const VIEW_H = 210;
const LEFT_X = 118;
const RIGHT_X = 372;
const BAR_W = 30;
// 极小的占比（例如输入常年不到 0.1%）给一个最小可见高度，
// 否则色带会没有起点。1.5px 相对 168px 的画布可忽略，精确数值以下方表格为准。
const MIN_SEGMENT = 1.5;

export default function VolumeVsCost({ totals, t, locale }) {
  const [hover, setHover] = useState(null);

  const rows = useMemo(() => {
    const defs = [
      { key: 'cacheRead', label: t.cacheRead, color: '#8b5cf6', tokens: totals.cacheReadTokens, cost: totals.costCacheRead },
      { key: 'cacheWrite', label: t.cacheWrite, color: '#c4b5fd', tokens: totals.cacheWriteTokens, cost: totals.costCacheWrite },
      { key: 'output', label: t.output, color: '#10b981', tokens: totals.outputTokens, cost: totals.costOutput },
      { key: 'input', label: t.input, color: '#3b82f6', tokens: totals.inputTokens, cost: totals.costInput },
    ];
    const tokenSum = defs.reduce((a, d) => a + d.tokens, 0);
    const costSum = defs.reduce((a, d) => a + d.cost, 0);
    return defs.map((d) => ({
      ...d,
      tokenShare: tokenSum ? d.tokens / tokenSum : 0,
      costShare: costSum ? d.cost / costSum : 0,
      // 有效单价：这一类 token 实际每百万花了多少钱，是最能说明问题的一个数。
      rate: d.tokens ? (d.cost / d.tokens) * 1e6 : 0,
    }));
  }, [totals, t]);

  const bands = useMemo(() => {
    let ly = BAR_TOP;
    let ry = BAR_TOP;
    return rows.map((r) => {
      const lh = Math.max(r.tokenShare * BAR_HEIGHT, r.tokens > 0 ? MIN_SEGMENT : 0);
      const rh = Math.max(r.costShare * BAR_HEIGHT, r.cost > 0 ? MIN_SEGMENT : 0);
      const band = { ...r, ly, lh, ry, rh };
      ly += lh;
      ry += rh;
      return band;
    });
  }, [rows]);

  /**
   * 最贵与最便宜档位之间的倍数。
   *
   * 这才是这张图真正的结论：同样一百万 token，落在不同档位上价格能差几十倍，
   * 所以「省 token」和「省钱」不是同一件事。
   */
  const spread = useMemo(() => {
    const priced = rows.filter((r) => r.tokens > 0 && r.rate > 0);
    if (priced.length < 2) return null;
    const max = priced.reduce((a, b) => (b.rate > a.rate ? b : a));
    const min = priced.reduce((a, b) => (b.rate < a.rate ? b : a));
    const ratio = max.rate / min.rate;
    if (!Number.isFinite(ratio) || ratio < 2) return null;
    return { max, min, ratio: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) };
  }, [rows]);

  const hasData = rows.some((r) => r.tokens > 0);
  if (!hasData) return null;

  const pct = (v) => `${(v * 100).toFixed(v > 0 && v < 0.001 ? 3 : 1)}%`;
  const money = (v) => `$${v.toFixed(2)}`;
  const rate = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

  return (
    <div>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="vvc-svg" role="img"
        aria-label={`${t.volumeVsCost}: ${rows.map((r) => `${r.label} ${pct(r.tokenShare)} / ${pct(r.costShare)}`).join('; ')}`}>
        <text x={LEFT_X + BAR_W / 2} y={18} className="vvc-colhead" textAnchor="middle">{t.volumeCol}</text>
        <text x={RIGHT_X + BAR_W / 2} y={18} className="vvc-colhead" textAnchor="middle">{t.costCol}</text>

        {bands.map((b) => {
          const dim = hover && hover !== b.key;
          const lm = b.ly + b.lh;
          const rm = b.ry + b.rh;
          const c = (LEFT_X + BAR_W + RIGHT_X) / 2;
          return (
            <g key={b.key}
              opacity={dim ? 0.18 : 1}
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
              style={{ transition: 'opacity .15s' }}>
              {/* 连接色带：左侧用量份额流向右侧成本份额 */}
              <path
                d={`M${LEFT_X + BAR_W},${b.ly} C${c},${b.ly} ${c},${b.ry} ${RIGHT_X},${b.ry}
                    L${RIGHT_X},${rm} C${c},${rm} ${c},${lm} ${LEFT_X + BAR_W},${lm} Z`}
                fill={b.color} opacity={0.3} />
              <rect x={LEFT_X} y={b.ly} width={BAR_W} height={b.lh} fill={b.color} rx={1} />
              <rect x={RIGHT_X} y={b.ry} width={BAR_W} height={b.rh} fill={b.color} rx={1} />
              {/* 段太矮时不画字，避免叠字；精确数值在下方表格 */}
              {b.lh >= 13 && (
                <text x={LEFT_X - 8} y={b.ly + b.lh / 2 + 4} className="vvc-seglabel" textAnchor="end">
                  {b.label} {pct(b.tokenShare)}
                </text>
              )}
              {b.rh >= 13 && (
                <text x={RIGHT_X + BAR_W + 8} y={b.ry + b.rh / 2 + 4} className="vvc-seglabel">
                  {pct(b.costShare)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <table className="vvc-table">
        <thead>
          <tr>
            <th />
            <th className="text-right">{t.totalTokens}</th>
            <th className="text-right">{t.volumeCol}</th>
            <th className="text-right">{t.cost}</th>
            <th className="text-right">{t.costCol}</th>
            <th className="text-right">{t.effRate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}
              className={hover === r.key ? 'vvc-row-active' : undefined}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}>
              <td>
                <span className="vvc-swatch" style={{ background: r.color }} />
                {r.label}
                {r.key === 'cacheWrite' && totals.cacheWriteTokens > 0 && (
                  <span className="vvc-sub">
                    {t.ofWhich1h} {((totals.cacheWrite1h / totals.cacheWriteTokens) * 100).toFixed(0)}%
                  </span>
                )}
              </td>
              <td className="text-right">{r.tokens.toLocaleString(locale)}</td>
              <td className="text-right vvc-num">{pct(r.tokenShare)}</td>
              <td className="text-right">{money(r.cost)}</td>
              <td className="text-right vvc-num">{pct(r.costShare)}</td>
              <td className="text-right vvc-rate">${rate(r.rate)}{t.perMillion}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="vvc-hint">
        {t.volumeVsCostHint}
        {spread && (
          <>
            {' '}
            <strong className="vvc-spread">
              {t.rateSpread
                .replace('{max}', spread.max.label)
                .replace('{min}', spread.min.label)
                .replace('{x}', spread.ratio)}
            </strong>
          </>
        )}
      </p>
    </div>
  );
}
