#!/usr/bin/env node
/**
 * Codex 数据正确性自检（对应 verify.mjs 但独立成一份，互不影响）。
 *
 *   node scripts/verify-codex.mjs
 *
 * 做两件事：
 *  1) 独立地把日志重算一遍（不复用 codex-parser 的聚合代码），和缓存里的数字对账；
 *  2) 检查 session / conversation / project / daily 各层总额是否自洽。
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { refreshUsage, getCodexHomeDir, readTurnsShard } from '../app/lib/codex-parser-node.js';
import { extractTokens, calculateCost } from '../app/lib/pricing-codex.js';

const money = (n) => '$' + n.toFixed(2);
const eq = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

function collectJsonl(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

/** 独立重算：直接扫日志、按 total_token_usage 差分，不碰 codex-parser 的聚合逻辑。 */
async function independentTotals() {
  const homeDir = getCodexHomeDir();
  const files = [];
  collectJsonl(path.join(homeDir, 'sessions'), files);
  collectJsonl(path.join(homeDir, 'archived_sessions'), files);

  let events = 0;
  let tokens = 0;
  let cost = 0;
  const quotaReadings = [];

  for (const filePath of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let prevTotal = null;
    let currentModel = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const payload = e.payload;
      if (e.type === 'turn_context' && payload && payload.model) {
        currentModel = payload.model;
        continue;
      }
      if (e.type !== 'event_msg' || !payload) continue;
      if (payload.type !== 'token_count') continue;
      const info = payload.info;
      if (!info) continue;
      const total = info.total_token_usage || null;
      let last = info.last_token_usage;
      if (!last && total) {
        const p = prevTotal || {};
        last = {
          input_tokens: Math.max((total.input_tokens || 0) - (p.input_tokens || 0), 0),
          cached_input_tokens: Math.max((total.cached_input_tokens || 0) - (p.cached_input_tokens || 0), 0),
          cache_write_input_tokens: Math.max((total.cache_write_input_tokens || 0) - (p.cache_write_input_tokens || 0), 0),
          output_tokens: Math.max((total.output_tokens || 0) - (p.output_tokens || 0), 0),
          reasoning_output_tokens: Math.max((total.reasoning_output_tokens || 0) - (p.reasoning_output_tokens || 0), 0),
        };
      }
      if (total) prevTotal = total;
      if (!last) continue;
      const tk = extractTokens(last);
      if (tk.totalTokens === 0) continue;
      events++;
      tokens += tk.totalTokens;
      cost += calculateCost(tk, currentModel || 'gpt-5');
      const rl = payload.rate_limits;
      if (rl && rl.primary && rl.primary.window_minutes === 300 && typeof rl.primary.used_percent === 'number') {
        quotaReadings.push({ ts: e.timestamp, pct: rl.primary.used_percent, reset: rl.primary.resets_at });
      }
    }
  }
  return { files: files.length, events, tokens, cost, quotaReadings };
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(label);
}

console.log(`Codex 日志目录: ${getCodexHomeDir()}\n`);
console.log('重新解析全部日志...');
const cache = await refreshUsage({ force: true });
console.log(`  ${cache.stats.filesParsed} 个文件, ${cache.stats.linesParsed.toLocaleString()} 行, `
  + `耗时 ${cache.stats.durationMs}ms\n`);

console.log('独立重算对账...');
const ind = await independentTotals();
const before = cache.summary;

let after = before;
let grew = false;
if (ind.events !== before.turnCount) {
  console.log('  数字对不上，重新解析一次以判别是否为日志增长...');
  after = (await refreshUsage({ force: true })).summary;
  grew = before.turnCount <= ind.events && ind.events <= after.turnCount
    && before.totalTokens <= ind.tokens && ind.tokens <= after.totalTokens;
  if (grew) console.log(`  确认为日志增长：解析 ${before.turnCount} → 独立 ${ind.events} → 再解析 ${after.turnCount}`);
}

const matches = (a, b) => a === b || grew;
check('调用次数一致', matches(ind.events, before.turnCount),
  grew ? '（日志增长期间，单调性成立）' : `独立=${ind.events} 缓存=${before.turnCount}`);
check('token 数一致', matches(ind.tokens, before.totalTokens),
  grew ? '' : `独立=${ind.tokens.toLocaleString()} 缓存=${before.totalTokens.toLocaleString()}`);
check('成本一致', eq(ind.cost, before.totalCost, 1e-6) || grew,
  grew ? '' : `独立=${money(ind.cost)} 缓存=${money(before.totalCost)}`);

console.log('\n各层总额自洽...');
const sessions = Object.values(cache.sessions);
const conversations = Object.values(cache.conversations);
let shardTokens = 0;
let shardCost = 0;
for (const s of sessions) {
  for (const t of await readTurnsShard(s.sessionId)) { shardTokens += t.totalTokens; shardCost += t.cost; }
}
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const layers = {
  'turn 分片': [shardTokens, shardCost],
  sessions: [sum(sessions, 'totalTokens'), sum(sessions, 'cost')],
  projects: [sum(cache.projects, 'totalTokens'), sum(cache.projects, 'totalCost')],
  conversations: [sum(conversations, 'totalTokens'), sum(conversations, 'cost')],
  daily: [sum(cache.daily, 'totalTokens'), sum(cache.daily, 'totalCost')],
  summary: [cache.summary.totalTokens, cache.summary.totalCost],
};
for (const [name, [tk, ct]] of Object.entries(layers)) {
  console.log(`     ${name.padEnd(14)} ${String(tk).padStart(15)}  ${money(ct).padStart(12)}`);
}
const tokenVals = Object.values(layers).map((v) => v[0]);
const costVals = Object.values(layers).map((v) => v[1]);
check('六层 token 相等', tokenVals.every((v) => v === tokenVals[0]));
check('六层成本相等', costVals.every((v) => eq(v, costVals[0], 1e-6)));

console.log('\n数据完整性...');
const convIds = new Set(conversations.map((c) => c.id));
let orphanTurns = 0;
let subagentTurns = 0;
for (const s of sessions) {
  for (const t of await readTurnsShard(s.sessionId)) {
    // 并入根会话的子 agent，用量算在 attachedTo 指向的那条提问上，分片里保留的是原对话 id。
    const convId = s.attachedTo ? s.attachedTo.conversationId : t.conversationId;
    if (s.attachedTo) subagentTurns++;
    if (!convIds.has(convId)) orphanTurns++;
  }
}
check('无孤儿 turn', orphanTurns === 0, `${orphanTurns} 条`);
console.log(`     其中并入根会话的子 agent 调用 ${subagentTurns} 条`);
check('解析无丢行', cache.stats.linesSkipped === 0, `跳过 ${cache.stats.linesSkipped} 行`);

console.log('\n额度读数...');
// 独立从原始日志算：每个 5 小时窗口里，读数从第一条涨到峰值的总量；
// 应该等于全部对话「额度占用」之和（分摊只是把总量分给各条对话，不能凭空多出或丢掉）。
const readings = ind.quotaReadings.slice().sort((a, b) => a.reset - b.reset);
const windows = [];
for (const r of readings) {
  const w = windows[windows.length - 1];
  if (w && r.reset - w.lastReset <= 60) { w.list.push(r); w.lastReset = r.reset; } else windows.push({ list: [r], lastReset: r.reset });
}
let expectedRise = 0;
for (const w of windows) {
  const list = w.list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  expectedRise += Math.max(...list.map((r) => r.pct)) - list[0].pct;
}
const quotaSum = conversations.reduce((a, c) => a + (c.quotaPct || 0), 0);
check('对话额度占用之和 = 各窗口读数总上涨量', eq(quotaSum, expectedRise, 1e-6),
  `${quotaSum.toFixed(2)} vs ${expectedRise}`);
check('额度占用无负数、无超出 100%', conversations.every((c) => c.quotaPct == null || (c.quotaPct >= 0 && c.quotaPct <= 100.0001)));

console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : '\n✓ 全部通过');
process.exit(failures.length ? 1 : 0);
