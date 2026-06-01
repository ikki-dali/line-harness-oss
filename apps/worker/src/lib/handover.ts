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
    // 意図的な fail-open。本 MVP は AI 主体（既定 'ai'）で、metadata 破損は
    // 別バグ起因の例外状態。ここで 'human' に倒すと破損 friend の AI が
    // 無言で恒久停止し、無人運用だと誰も気づけない逆リスクがある。
    // 有人運用が前提化したら fail-safe('human') への変更を再検討する。
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
  // 破損 metadata でも takeover（有人切替）が落ちないよう parse 失敗は {} に倒す。
  // handover の書き込みは「人手で引き継いだ」確定操作なので、ここで throw させない。
  let m: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      m = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      m = {};
    }
  }
  m.handover = state;
  await db
    .prepare('UPDATE friends SET metadata = ? WHERE id = ?')
    .bind(JSON.stringify(m), friendId)
    .run();
}
