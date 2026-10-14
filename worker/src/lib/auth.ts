import type { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Bearer トークンの定数時間比較(タイミング攻撃対策)。
 * 長さが違う場合は即 false だが、その判定自体の時間差は許容(秘密の長さは漏れても実害が小さい)。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * 計画書 §6: 認証は2系統(書込系=INGEST_SECRET、読取系=READ_API_TOKEN)。
 * secretKey で env の該当シークレットと比較する Hono ミドルウェアを返す。
 */
export function requireBearer(secretKey: 'INGEST_SECRET' | 'READ_API_TOKEN') {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const expected = c.env[secretKey];
    const token = extractBearer(c.req.header('Authorization'));
    if (!expected || !token || !timingSafeEqual(token, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
