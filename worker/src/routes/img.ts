import { Hono } from 'hono';
import type { Env } from '../types';
import { cacheResponse } from '../lib/cache';

/**
 * 投稿サムネイルのプロキシ。posts.thumbnail_url(署名付き fbcdn URL)を
 * サーバー側で取得して配信する。ブラウザから直接 fbcdn を読むと referrer/CORS で
 * 弾かれるのを回避する狙い。URL 失効や取得失敗時は中立なプレースホルダ SVG を返し、
 * <img> のレイアウトが崩れないようにする(styles が崩れない要件)。
 */
const img = new Hono<{ Bindings: Env }>();

// Workers Cache(計画書 §5.5): サムネはほぼ不変なので7日。プレースホルダ(SVG)は
// URL 失効からの復旧を待てるよう短TTL(3600s)。TTL はレスポンス確定後に判定する。
img.use(
  '*',
  cacheResponse(
    (c) => ((c.res.headers.get('content-type') ?? '').startsWith('image/svg') ? 3600 : 604800),
    { browserCacheable: true } // 画像は不変・全読者共通なのでブラウザにもキャッシュを許可
  )
);

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
<rect width="160" height="160" fill="#e4e4e7"/>
<path d="M50 104l24-24 16 16 12-12 20 20" fill="none" stroke="#a1a1aa" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="62" cy="60" r="9" fill="#a1a1aa"/></svg>`;

function placeholder(): Response {
  return new Response(PLACEHOLDER, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=300',
    },
  });
}

img.get('/:post_id', async (c) => {
  const postId = Number(c.req.param('post_id'));
  if (!Number.isInteger(postId)) return placeholder();

  const row = await c.env.DB
    .prepare(`SELECT thumbnail_url FROM posts WHERE id = ?`)
    .bind(postId)
    .first<{ thumbnail_url: string | null }>();

  const url = row?.thumbnail_url;
  if (!url) return placeholder();

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://www.instagram.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      // 失効/障害時に長く待たない
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!upstream.ok) return placeholder();
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return placeholder();

    return new Response(upstream.body, {
      headers: {
        'content-type': contentType,
        // サムネはほぼ不変。ブラウザ/エッジで1日キャッシュ。
        'cache-control': 'public, max-age=86400',
      },
    });
  } catch {
    return placeholder();
  }
});

export default img;
