import { NextResponse } from 'next/server';
import { readCache, readTurnsShard } from '../../../lib/parser.js';

export const dynamic = 'force-dynamic';

/**
 * turn 级明细，按需拉取。
 *
 * turn 数据量随使用时长线性增长（实测 34 天已有 7600+ 条），
 * 全量塞进主接口会让 payload 涨到几 MB 且绝大多数用户永远用不到。
 * 必须带 sessionId 或 conversationId，不支持无过滤的全量拉取。
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const conversationId = searchParams.get('conversationId');

    if (!sessionId && !conversationId) {
      return NextResponse.json(
        { error: '需要 sessionId 或 conversationId 参数' },
        { status: 400 }
      );
    }

    // conversationId 形如 "<sessionId>:<uuid>"，可以直接反解出所在分片，
    // 不必扫描全部分片。
    const targetSession = sessionId || conversationId.split(':')[0];
    const { cache } = await readCache();
    if (!cache.sessions[targetSession]) {
      return NextResponse.json({ turns: [] });
    }

    let turns = await readTurnsShard(targetSession);
    if (conversationId) turns = turns.filter((t) => t.conversationId === conversationId);

    return NextResponse.json({ turns });
  } catch (error) {
    console.error('[usage/turns] 读取失败:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
