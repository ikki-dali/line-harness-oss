// HMAC-SHA256 と定数時間比較の共通ヘルパ。
// webhooks.ts (incoming webhook 署名検証) と timerex-link.ts (予約リンク署名)
// timerex.ts (固定トークン照合) で重複していた実装を一本化（security-reviewer 指摘）。

/** secret で message を HMAC-SHA256 し、小文字 hex 文字列を返す。 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定数時間文字列比較。長さの不一致も diff に混入させ、長さオラクル
 * (レスポンスタイムから一致長を推測される攻撃) を防ぐ。hex・平文トークン両用。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
