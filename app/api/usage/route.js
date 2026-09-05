import { NextResponse } from 'next/server';
import { readCache, refreshUsage } from '../../lib/parser.js';

// 依赖本机文件系统，不能被静态化或缓存。
export const dynamic = 'force-dynamic';

/**
 * 返回看板主数据。
 *
 * 不含 turn 级明细：turn 占整个数据量的 90% 以上，而且只有下钻到单条
 * conversation 时才用得上，改由 /api/usage/turns 按需拉取。
 */
function toPayload(cache) {
  return {
    generatedAt: cache.generatedAt,
    summary: cache.summary,
    projects: cache.projects,
    daily: cache.daily,
    sessions: Object.values(cache.sessions),
    conversations: Object.values(cache.conversations),
    stats: cache.stats,
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get('refresh') === 'true';
    const reset = searchParams.get('reset') === 'true';

    if (refresh || reset) {
      return NextResponse.json(toPayload(await refreshUsage({ force: reset })));
    }

    const { cache, rebuildReason } = await readCache();
    // 没有可用缓存（首次启动、版本升级、缓存损坏）时自动跑一次全量解析，
    // 否则用户会看到一个空白看板却不知道该点什么。
    if (rebuildReason) {
      return NextResponse.json(toPayload(await refreshUsage({ force: true })));
    }
    return NextResponse.json(toPayload(cache));
  } catch (error) {
    console.error('[usage] 读取失败:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
