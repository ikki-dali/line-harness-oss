export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface MessageRow {
  direction: string;
  content: string;
  created_at: string;
}

/**
 * messages_log から指定 friend の直近 limit*2 件（text）を取得し、
 * 時系列昇順の user/assistant ターン列に変換する。
 */
export async function getRecentHistory(
  db: D1Database,
  friendId: string,
  limit: number,
): Promise<ChatTurn[]> {
  const { results } = await db
    .prepare(
      `SELECT direction, content, created_at
       FROM messages_log
       WHERE friend_id = ? AND message_type = 'text' AND content IS NOT NULL AND content != ''
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(friendId, limit * 2)
    .all<MessageRow>();

  return (results ?? [])
    .slice()
    .reverse()
    .map((r) => ({
      role: r.direction === 'incoming' ? ('user' as const) : ('assistant' as const),
      content: r.content,
    }));
}
