/**
 * 日時変換ユーティリティ
 */

/**
 * タイムスタンプをISO8601形式に変換
 * @param ts タイムスタンプ（ミリ秒または秒）
 * @returns ISO8601文字列、無効な場合はnull
 */
export function toIsoTime(ts: unknown): string | null {
  const num = Number(ts);
  if (!Number.isFinite(num)) return null;
  const d = new Date(num);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

/**
 * タイムスタンプを日本語表示形式に変換
 * @param ts ミリ秒タイムスタンプ（未指定時は現在時刻）
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns "2025/01/15 14:30:00 JST" 形式
 */
export function toDisplayTime(ts?: number, tz = 'Asia/Tokyo'): string | null {
  try {
    const d = new Date(ts ?? Date.now());
    const time = d.toLocaleTimeString('ja-JP', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const date = d.toLocaleDateString('ja-JP', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const tzShort = tz === 'UTC' ? 'UTC' : 'JST';
    return `${date} ${time} ${tzShort}`;
  } catch {
    return null;
  }
}
