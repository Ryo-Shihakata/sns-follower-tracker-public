/**
 * docs/insights-reports-plan.md §5.5: Workers Cache(caches.default)の薄いヘルパー。
 * キーはリクエスト URL。認証付き API では **認証検証を通過した後に** この
 * ミドルウェアを適用すること(Authorization はキーに含めない。トークンは全読者
 * 共通のため衝突リスクなし)。レスポンスに X-Cache: HIT|MISS を付与する。
 */
import type { Context, Next } from 'hono';
import type { Env } from '../types';

type CacheContext = Context<{ Bindings: Env }>;

export interface CacheOptions {
  /**
   * ブラウザにもキャッシュを許可するか(既定 false)。
   * false: `public, s-maxage=N, max-age=0` — エッジ(caches.default = 共有キャッシュ)は
   *        s-maxage で N 秒保持するが、ブラウザ/中間プロキシは max-age=0 で毎回再取得する。
   *        認証必須の API JSON 向け(クライアント側で古い値を握らせない)。
   * true:  `public, max-age=N` — ブラウザにも N 秒キャッシュを許可。画像など不変・
   *        全読者共通で再ダウンロードを避けたいレスポンス向け。
   */
  browserCacheable?: boolean;
}

/**
 * GET レスポンス(200 のみ)を caches.default に TTL 付きで保存する Hono ミドルウェア。
 * ttl は秒数、または c から算出するコールバック(next 実行後に評価するので
 * c.res のヘッダ等を見て TTL を変えられる。/img のプレースホルダ短TTL用)。
 */
export function cacheResponse(
  ttl: number | ((c: CacheContext) => number),
  opts: CacheOptions = {}
) {
  return async (c: CacheContext, next: Next) => {
    if (c.req.method !== 'GET') {
      await next();
      return;
    }

    const key = new Request(c.req.url);
    const hit = await caches.default.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Cache', 'HIT');
      c.res = new Response(hit.body, { status: hit.status, headers });
      return;
    }

    await next();
    if (c.res.status !== 200) return;

    const seconds = typeof ttl === 'function' ? ttl(c) : ttl;
    const cacheControl = opts.browserCacheable
      ? `public, max-age=${seconds}`
      : `public, s-maxage=${seconds}, max-age=0`;
    try {
      c.res.headers.set('Cache-Control', cacheControl);
      c.res.headers.set('X-Cache', 'MISS');
    } catch {
      // immutable headers(素の fetch レスポンス等)は作り直す
      c.res = new Response(c.res.body, {
        status: c.res.status,
        headers: new Headers(c.res.headers),
      });
      c.res.headers.set('Cache-Control', cacheControl);
      c.res.headers.set('X-Cache', 'MISS');
    }
    // put はレスポンス返却をブロックしない
    c.executionCtx.waitUntil(caches.default.put(key, c.res.clone()));
  };
}

/** 明示パージ(regenerate 用)。クエリ付きバリアントまでは列挙できないため素の URL のみ。 */
export async function purgeCache(url: string): Promise<boolean> {
  return caches.default.delete(new Request(url));
}
