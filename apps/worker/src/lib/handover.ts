/**
 * 人 × AI の切替状態を friends.metadata.handover で表現する。
 * 'ai'（既定）: AI が自動応答する / 'human': 有人対応中につき AI は黙る。
 * 新規テーブルを作らず既存 metadata(JSON) に相乗りする。
 */
export type HandoverState = 'ai' | 'human';

export function getHandover(friend: { metadata?: string | null }): HandoverState {
  if (!friend.metadata) return 'ai';
  try {
    const m = JSON.parse(friend.metadata) as { handover?: string };
    return m.handover === 'human' ? 'human' : 'ai';
  } catch {
    return 'ai';
  }
}

export async function setHandover(
  db: D1Database,
  friendId: string,
  state: HandoverState,
): Promise<void> {
  const row = await db
    .prepare('SELECT metadata FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ metadata: string | null }>();
  const m = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  m.handover = state;
  await db
    .prepare('UPDATE friends SET metadata = ? WHERE id = ?')
    .bind(JSON.stringify(m), friendId)
    .run();
}
