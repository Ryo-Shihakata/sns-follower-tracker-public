/**
 * 読取系(GET /api/series, /api/posts, /api/events)とダッシュボード(dashboard.ts)が
 * 共有する SELECT クエリ群。書込は lib/accounts.ts, lib/events.ts 側に分離してある。
 */
import type { AccountRow } from './accounts';

export interface SeriesPoint {
  collected_at: string;
  followers: number;
}

export interface AccountSeries {
  account_id: number;
  platform_id: string;
  handle: string;
  display_name: string | null;
  points: SeriesPoint[];
}

export async function getSeriesForAccounts(
  db: D1Database,
  accountIds: number[],
  from: string | null,
  to: string | null
): Promise<AccountSeries[]> {
  const result: AccountSeries[] = [];
  for (const id of accountIds) {
    const account = await db
      .prepare(`SELECT id, platform_id, handle, display_name FROM accounts WHERE id = ?`)
      .bind(id)
      .first<Pick<AccountRow, 'id' | 'platform_id' | 'handle' | 'display_name'>>();
    if (!account) continue;

    let query = `SELECT collected_at, followers FROM snapshots WHERE account_id = ?`;
    const binds: unknown[] = [id];
    if (from) {
      query += ` AND collected_at >= ?`;
      binds.push(from);
    }
    if (to) {
      query += ` AND collected_at <= ?`;
      binds.push(to);
    }
    query += ` ORDER BY collected_at ASC`;

    const { results } = await db.prepare(query).bind(...binds).all<SeriesPoint>();
    result.push({
      account_id: account.id,
      platform_id: account.platform_id,
      handle: account.handle,
      display_name: account.display_name,
      points: results ?? [],
    });
  }
  return result;
}

export interface LatestPostMetrics {
  collected_at: string;
  likes: number | null;
  comments: number | null;
  views: number | null;
  reach: number | null;
  impressions: number | null;
  saved: number | null;
}

export interface PostWithLatest {
  id: number;
  external_id: string;
  url: string | null;
  posted_at: string | null;
  media_type: string | null;
  caption_head: string | null;
  caption_full: string | null;
  has_thumbnail: boolean; // thumbnail_url を持つか(URL 自体はプロキシ経由なのでクライアントに渡さない)
  latest: LatestPostMetrics | null;
  sparkline: number[]; // likes の推移(直近まで、グラフ用の簡易系列)
}

export async function getPostsWithLatest(
  db: D1Database,
  accountId: number,
  limit: number
): Promise<PostWithLatest[]> {
  const { results: posts } = await db
    .prepare(
      `SELECT id, external_id, url, posted_at, media_type, caption_head, caption_full, thumbnail_url
       FROM posts WHERE account_id = ?
       ORDER BY posted_at DESC, id DESC LIMIT ?`
    )
    .bind(accountId, limit)
    .all<{
      id: number;
      external_id: string;
      url: string | null;
      posted_at: string | null;
      media_type: string | null;
      caption_head: string | null;
      caption_full: string | null;
      thumbnail_url: string | null;
    }>();

  const out: PostWithLatest[] = [];
  for (const p of posts ?? []) {
    const latest = await db
      .prepare(
        `SELECT collected_at, likes, comments, views, reach, impressions, saved
         FROM post_snapshots WHERE post_id = ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(p.id)
      .first<LatestPostMetrics>();

    const { results: sparkRows } = await db
      .prepare(
        `SELECT likes FROM post_snapshots WHERE post_id = ? ORDER BY collected_at ASC`
      )
      .bind(p.id)
      .all<{ likes: number | null }>();

    const { thumbnail_url, ...rest } = p;
    out.push({
      ...rest,
      has_thumbnail: !!thumbnail_url,
      latest: latest ?? null,
      sparkline: (sparkRows ?? []).map((r) => r.likes ?? 0),
    });
  }
  return out;
}

export async function getPostSeries(db: D1Database, postId: number) {
  const { results } = await db
    .prepare(
      `SELECT collected_at, likes, comments, views, reach, impressions, saved
       FROM post_snapshots WHERE post_id = ? ORDER BY collected_at ASC`
    )
    .bind(postId)
    .all();
  return results ?? [];
}

export interface EventRow {
  id: number;
  type: string;
  account_id: number | null;
  message: string;
  payload_json: string | null;
  created_at: string;
  acknowledged: number;
}

export async function getEvents(
  db: D1Database,
  opts: { since?: string | null; type?: string | null; limit?: number }
): Promise<EventRow[]> {
  let query = `SELECT * FROM events WHERE 1 = 1`;
  const binds: unknown[] = [];
  if (opts.since) {
    query += ` AND created_at >= ?`;
    binds.push(opts.since);
  }
  if (opts.type) {
    query += ` AND type = ?`;
    binds.push(opts.type);
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  binds.push(opts.limit ?? 200);

  const { results } = await db.prepare(query).bind(...binds).all<EventRow>();
  return results ?? [];
}

export async function setEventAcknowledged(
  db: D1Database,
  id: number,
  acknowledged: boolean
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE events SET acknowledged = ? WHERE id = ?`)
    .bind(acknowledged ? 1 : 0, id)
    .run();
  return res.meta.changes > 0;
}
