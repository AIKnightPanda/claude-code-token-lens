#!/usr/bin/env node
/**
 * 数据正确性自检。
 *
 *   node scripts/verify.mjs
 *
 * 做两件事：
 *  1) 独立地把日志重算一遍（不复用 parser 的聚合代码），和缓存里的数字对账；
 *  2) 检查 session / conversation / project / daily 各层总额是否自洽。
 *
 * 这个项目的价值取决于数字对不对，所以对账要能随时跑，而不是靠人工抽查。
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { refreshUsage, getProjectsDir, readTurnsShard, DEDUP_SCOPE } from '../app/lib/parser-node.js';
import { extractTokens, calculateCost } from '../app/lib/pricing.js';

const money = (n) => '$' + n.toFixed(2);
const eq = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

/** 独立重算：直接扫日志，只用 pricing 模块，不碰 parser 的聚合逻辑。 */
async function independentTotals() {
  const dir = getProjectsDir();
  const seen = new Map();
  let files = 0;

  for (const folder of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    for (const name of fs.readdirSync(path.join(dir, folder.name))) {
      if (!name.endsWith('.jsonl')) continue;
      files++;
      const filePath = path.join(dir, folder.name, name);
      const fileSessionId = name.slice(0, -6);
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'assistant') continue;
        const usage = e.message && e.message.usage;
        if (!usage) continue;
        const model = e.message.model || 'claude-sonnet-5';
        if (model === '<synthetic>') continue;
        const msgId = e.message.id;
        if (!msgId) continue;

        const key = DEDUP_SCOPE === 'global'
          ? msgId + ' ' + (e.requestId || '')
          : msgId + ' ' + (e.requestId || '') + ' ' + (e.sessionId || fileSessionId);

        const tokens = extractTokens(usage);
        const prev = seen.get(key);
        // 与 parser 一致：同键冲突保留 token 更大的那条。
        if (prev && prev.totalTokens >= tokens.totalTokens) continue;
        seen.set(key, {
          totalTokens: tokens.totalTokens,
          cost: calculateCost(tokens, model, { speed: usage.speed }),
        });
      }
    }
  }

  let tokens = 0;
  let cost = 0;
  for (const v of seen.values()) { tokens += v.totalTokens; cost += v.cost; }
  return { files, turns: seen.size, tokens, cost };
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(label);
}

console.log(`去重口径: ${DEDUP_SCOPE}\n`);
console.log('重新解析全部日志...');
const cache = await refreshUsage({ force: true });
console.log(`  ${cache.stats.filesParsed} 个文件, ${cache.stats.linesParsed.toLocaleString()} 行, `
  + `剔除重复 ${cache.stats.duplicatesDropped.toLocaleString()} 条, 耗时 ${cache.stats.durationMs}ms\n`);

console.log('独立重算对账...');
const ind = await independentTotals();
const before = cache.summary;

/**
 * 日志可能正在被写入（比如此刻就开着 Claude Code），
 * 解析和独立重算之间隔了新数据，就会出现「独立 = 缓存 + 1」这种假失败。
 *
 * 判别方法：独立重算发生在两次解析之间，所以只要
 *   第一次解析 ≤ 独立重算 ≤ 第二次解析
 * 三者单调递增，就说明差异来自日志增长而不是算错。
 */
let after = before;
let grew = false;
if (ind.turns !== before.turnCount) {
  console.log('  数字对不上，重新解析一次以判别是否为日志增长...');
  after = (await refreshUsage({ force: true })).summary;
  grew = before.turnCount <= ind.turns && ind.turns <= after.turnCount
    && before.totalTokens <= ind.tokens && ind.tokens <= after.totalTokens;
  if (grew) console.log(`  确认为日志增长：解析 ${before.turnCount} → 独立 ${ind.turns} → 再解析 ${after.turnCount}`);
}

const matches = (a, b) => a === b || grew;
check('turn 数一致', matches(ind.turns, before.turnCount),
  grew ? '（日志增长期间，单调性成立）' : `独立=${ind.turns} 缓存=${before.turnCount}`);
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
for (const s of sessions) {
  for (const t of await readTurnsShard(s.sessionId)) if (!convIds.has(t.conversationId)) orphanTurns++;
}
check('无孤儿 turn', orphanTurns === 0, `${orphanTurns} 条`);
check('无重复 dedupKey', await (async () => {
  const keys = new Set();
  for (const s of sessions) {
    for (const t of await readTurnsShard(s.sessionId)) {
      if (t.dedupKey) { if (keys.has(t.dedupKey)) return false; keys.add(t.dedupKey); }
    }
  }
  return true;
})());
check('解析无丢行', cache.stats.linesSkipped === 0, `跳过 ${cache.stats.linesSkipped} 行`);
check('所有模型有精确价格', cache.summary.estimatedPricing === false);

console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : '\n✓ 全部通过');
process.exit(failures.length ? 1 : 0);
