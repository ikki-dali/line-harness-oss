// 予約リンクの署名（なりすまし対策 = spec CRITICAL 案A）。
//
// 求職者ごとに予約 URL を動的生成する際、LINE userId だけだと第三者が他人の
// userId を付けて偽の確定通知を発火できる（CRITICAL）。これを防ぐため、
// userId + nonce を TIMEREX_LINK_SECRET で HMAC-SHA256 した署名 (sig) を URL に
// 同梱し、Webhook 受信時に再計算して照合する。照合できない予約は通知しない。
//
import { hmacSha256Hex, timingSafeEqual } from '../lib/hmac.js';

/** 署名対象文字列。userId と nonce の両方を含めることでリンクごとに一意。 */
function signingMessage(lineUserId: string, nonce: string): string {
  return `${lineUserId}:${nonce}`;
}

/** 推測不可能な nonce を生成。 */
export function newTimerexNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** userId + nonce の署名 (hex) を計算。 */
export async function signTimerexBooking(
  lineUserId: string,
  nonce: string,
  secret: string,
): Promise<string> {
  return hmacSha256Hex(secret, signingMessage(lineUserId, nonce));
}

/**
 * 予約 URL に line_user_id / nonce / sig を付与して返す。
 * LINE bot が友だちごとに呼んで配信する。
 */
export async function buildTimerexBookingUrl(
  baseCalendarUrl: string,
  lineUserId: string,
  secret: string,
  nonce: string = newTimerexNonce(),
): Promise<string> {
  const sig = await signTimerexBooking(lineUserId, nonce, secret);
  const url = new URL(baseCalendarUrl);
  url.searchParams.set('line_user_id', lineUserId);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('sig', sig);
  return url.toString();
}

/**
 * Webhook で回収した line_user_id / nonce / sig を検証する。
 * いずれか欠落、または署名不一致なら false（→ 通知スキップ）。
 */
export async function verifyTimerexBookingSignature(
  lineUserId: string | null | undefined,
  nonce: string | null | undefined,
  sig: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!lineUserId || !nonce || !sig) return false;
  const expected = await signTimerexBooking(lineUserId, nonce, secret);
  // TimeRex 側が大文字 hex を返す可能性に備え小文字化してから定数時間比較。
  return timingSafeEqual(sig.toLowerCase(), expected);
}
