/**
 * ダッシュボード v3(概要 KPI・増減バー・いいね時系列・モニター)の集計層。
 * 既存 queries.ts が「共有 SELECT」の役割なのに合わせ、ここは v3 追加分の
 * SELECT + 純関数の集計をまとめる。route(/api/*, /ui/*)からのみ呼ぶ。
 *
 * フォロワーは累積量なので、バケット集約は常に各バケットの「終値」(最後の
 * snapshot)を採用する(計画書 §3)。
 */
import type { AccountRow } from './accounts';
import type { SeriesPoint } from './queries';

export type Bucket = 'day' | 'week' | 'month';

export function normalizeBucket(v: string | null | undefined): Bucket {
  return v === 'week' || v === 'month' ? v : 'day';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 文字列をバケットキー(YYYY-MM-DD / 週=月曜日の日付 / YYYY-MM)へ。UTC 基準。 */
export function bucketKey(iso: string, bucket: Bucket): string {
  if (bucket === 'month') return iso.slice(0, 7);
  if (bucket === 'week') {
    const d = new Date(iso);
    const dow = d.getUTCDay(); // 0=日
    const shift = dow === 0 ? -6 : 1 - dow; // 週の始まりを月曜に
    const monday = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift)
    );
    return monday.toISOString().slice(0, 10);
  }
  return iso.slice(0, 10);
}

/**
 * 昇順の snapshot 列を各バケットの終値に集約する。
 * 入力は collected_at 昇順の前提。返り値も時系列順(各バケットの最終点)。
 */
export function aggregateToBucketEnds(points: SeriesPoint[], bucket: Bucket): SeriesPoint[] {
  const map = new Map<string, SeriesPoint>();
  for (const p of points) {
    // 昇順入力なので後勝ち = そのバケットの終値。Map はキー初出の位置を保つので時系列順。
    map.set(bucketKey(p.collected_at, bucket), p);
  }
  return [...map.values()];
}

// ---- 低レベル SELECT ----

async function fetchSnapshotPoints(
  db: D1Database,
  accountId: number,
  from: string | null,
  to: string | null
): Promise<SeriesPoint[]> {
  let query = `SELECT collected_at, followers FROM snapshots WHERE account_id = ?`;
  const binds: unknown[] = [accountId];
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
  return results ?? [];
}

/** account_id より前の最新 snapshot(バケット純増の基準点に使う)。 */
async function fetchSnapshotBefore(
  db: D1Database,
  accountId: number,
  before: string
): Promise<SeriesPoint | null> {
  return db
    .prepare(
      `SELECT collected_at, followers FROM snapshots
       WHERE account_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`
    )
    .bind(accountId, before)
    .first<SeriesPoint>();
}

async function fetchAccount(db: D1Database, accountId: number): Promise<AccountRow | null> {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
}

// ---- /api/summary ----

export interface SummaryResult {
  account_id: number;
  handle: string;
  display_name: string | null;
  managed: boolean;
  from: string | null;
  to: string | null;
  followers: number | null; // 現在値
  collected_at: string | null; // 現在値の時刻
  prev_followers: number | null; // 約24h前
  day_delta: number | null; // 前日比(絶対)
  day_pct: number | null; // 前日比(割合、0.0104 = 1.04%)
  period_net: number | null; // 期間純増(始点→終点)
  period_pct: number | null;
  avg_likes_recent: number | null; // 直近投稿の平均いいね
  recent_post_count: number;
  sparkline: number[]; // 期間の日次終値(KPIカードのスパークライン用)
}

export async function getSummary(
  db: D1Database,
  accountId: number,
  from: string | null,
  to: string | null
): Promise<SummaryResult | null> {
  const account = await fetchAccount(db, accountId);
  if (!account) return null;

  const points = await fetchSnapshotPoints(db, accountId, from, to);
  const daily = aggregateToBucketEnds(points, 'day');

  // 現在値: 範囲内の最終点。範囲が空なら全期間の最新。
  let current: SeriesPoint | null = points.length > 0 ? points[points.length - 1] : null;
  if (!current) {
    current = await db
      .prepare(
        `SELECT collected_at, followers FROM snapshots WHERE account_id = ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(accountId)
      .first<SeriesPoint>();
  }

  let prevFollowers: number | null = null;
  let dayDelta: number | null = null;
  let dayPct: number | null = null;
  if (current) {
    const cutoff = new Date(new Date(current.collected_at).getTime() - DAY_MS).toISOString();
    const prev = await db
      .prepare(
        `SELECT collected_at, followers FROM snapshots
         WHERE account_id = ? AND collected_at <= ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(accountId, cutoff)
      .first<SeriesPoint>();
    if (prev) {
      prevFollowers = prev.followers;
      dayDelta = current.followers - prev.followers;
      dayPct = prev.followers !== 0 ? dayDelta / prev.followers : null;
    }
  }

  let periodNet: number | null = null;
  let periodPct: number | null = null;
  if (points.length >= 2) {
    const start = points[0].followers;
    const end = points[points.length - 1].followers;
    periodNet = end - start;
    periodPct = start !== 0 ? periodNet / start : null;
  } else if (points.length === 1) {
    periodNet = 0;
    periodPct = 0;
  }

  // 直近投稿の平均いいね(最新の post_snapshot の likes、最大12投稿)
  const { results: likeRows } = await db
    .prepare(
      `SELECT (
         SELECT ps.likes FROM post_snapshots ps
         WHERE ps.post_id = p.id ORDER BY ps.collected_at DESC LIMIT 1
       ) AS likes
       FROM posts p WHERE p.account_id = ?
       ORDER BY p.posted_at DESC, p.id DESC LIMIT 12`
    )
    .bind(accountId)
    .all<{ likes: number | null }>();
  const likeVals = (likeRows ?? [])
    .map((r) => r.likes)
    .filter((v): v is number => typeof v === 'number');
  const avgLikes =
    likeVals.length > 0
      ? Math.round(likeVals.reduce((a, b) => a + b, 0) / likeVals.length)
      : null;

  return {
    account_id: account.id,
    handle: account.handle,
    display_name: account.display_name,
    managed: account.managed === 1,
    from,
    to,
    followers: current ? current.followers : null,
    collected_at: current ? current.collected_at : null,
    prev_followers: prevFollowers,
    day_delta: dayDelta,
    day_pct: dayPct,
    period_net: periodNet,
    period_pct: periodPct,
    avg_likes_recent: avgLikes,
    recent_post_count: likeRows?.length ?? 0,
    sparkline: daily.map((p) => p.followers),
  };
}

// ---- /api/overview(全アカウントの増減サマリー)----

export interface OverviewItem {
  account_id: number;
  platform_id: string;
  handle: string;
  display_name: string | null;
  managed: boolean;
  followers: number | null;
  day_delta: number | null;
  day_pct: number | null;
  period_net: number | null;
  period_pct: number | null;
  sparkline: number[];
}

/**
 * active な全アカウントの概要(現フォロワー・前日比・期間純増・スパークライン)を返す。
 * 概要ビューで「全アカウント」を選んだときの一覧表示に使う。
 */
export async function getOverview(
  db: D1Database,
  from: string | null,
  to: string | null
): Promise<OverviewItem[]> {
  const { results } = await db
    .prepare(`SELECT id, platform_id FROM accounts WHERE active = 1 ORDER BY id`)
    .all<{ id: number; platform_id: string }>();

  const out: OverviewItem[] = [];
  for (const a of results ?? []) {
    const s = await getSummary(db, a.id, from, to);
    if (!s) continue;
    out.push({
      account_id: s.account_id,
      platform_id: a.platform_id,
      handle: s.handle,
      display_name: s.display_name,
      managed: s.managed,
      followers: s.followers,
      day_delta: s.day_delta,
      day_pct: s.day_pct,
      period_net: s.period_net,
      period_pct: s.period_pct,
      sparkline: s.sparkline,
    });
  }
  return out;
}

// ---- /api/followers/diff ----

export interface FollowersDiffBucket {
  bucket_start: string;
  followers: number; // バケット終値
  net: number; // 直前バケット(または基準点)との差
}

export interface FollowersDiffResult {
  account_id: number;
  bucket: Bucket;
  from: string | null;
  to: string | null;
  buckets: FollowersDiffBucket[];
}

export async function getFollowersDiff(
  db: D1Database,
  accountId: number,
  from: string | null,
  to: string | null,
  bucket: Bucket
): Promise<FollowersDiffResult | null> {
  const account = await fetchAccount(db, accountId);
  if (!account) return null;

  const points = await fetchSnapshotPoints(db, accountId, from, to);
  const ends = aggregateToBucketEnds(points, bucket);

  // 最初のバケットの純増を出すため、from 直前の snapshot を基準にする。
  let prev: number | null = null;
  if (from) {
    const baseline = await fetchSnapshotBefore(db, accountId, from);
    if (baseline) prev = baseline.followers;
  }

  const buckets: FollowersDiffBucket[] = ends.map((p) => {
    const net = prev === null ? 0 : p.followers - prev;
    prev = p.followers;
    return {
      bucket_start: bucketKey(p.collected_at, bucket),
      followers: p.followers,
      net,
    };
  });

  return { account_id: account.id, bucket, from, to, buckets };
}

// ---- /api/likes/series ----

export interface LikesSeriesPoint {
  collected_at: string;
  likes: number | null;
}

export interface LikesSeriesItem {
  post_id: number;
  external_id: string;
  url: string | null;
  posted_at: string | null;
  caption_head: string | null;
  latest_likes: number | null;
  points: LikesSeriesPoint[];
}

export interface LikesSeriesResult {
  account_id: number;
  series: LikesSeriesItem[];
}

export async function getLikesSeries(
  db: D1Database,
  accountId: number,
  limit: number
): Promise<LikesSeriesResult | null> {
  const account = await fetchAccount(db, accountId);
  if (!account) return null;

  const { results: posts } = await db
    .prepare(
      `SELECT id, external_id, url, posted_at, caption_head
       FROM posts WHERE account_id = ?
       ORDER BY posted_at DESC, id DESC LIMIT ?`
    )
    .bind(accountId, limit)
    .all<{
      id: number;
      external_id: string;
      url: string | null;
      posted_at: string | null;
      caption_head: string | null;
    }>();

  const series: LikesSeriesItem[] = [];
  for (const p of posts ?? []) {
    const { results: pts } = await db
      .prepare(
        `SELECT collected_at, likes FROM post_snapshots
         WHERE post_id = ? ORDER BY collected_at ASC`
      )
      .bind(p.id)
      .all<LikesSeriesPoint>();
    const list = pts ?? [];
    const latest = list.length > 0 ? list[list.length - 1].likes : null;
    series.push({
      post_id: p.id,
      external_id: p.external_id,
      url: p.url,
      posted_at: p.posted_at,
      caption_head: p.caption_head,
      latest_likes: latest,
      points: list,
    });
  }

  return { account_id: account.id, series };
}

// ---- /api/monitor ----

export interface MonitorPost {
  external_id: string;
  posted_at: string | null;
  url: string | null;
  likes: number | null;
}

export interface MonitorResult {
  account_id: number;
  handle: string;
  display_name: string | null;
  followers: number | null;
  collected_at: string | null;
  day_delta: number | null;
  day_pct: number | null;
  latest_posts: MonitorPost[]; // 最新3件
  sparkline: number[]; // 直近14日の日次終値
}

export async function getMonitor(
  db: D1Database,
  accountId: number
): Promise<MonitorResult | null> {
  const account = await fetchAccount(db, accountId);
  if (!account) return null;

  const from = new Date(Date.now() - 14 * DAY_MS).toISOString();
  const points = await fetchSnapshotPoints(db, accountId, from, null);
  const daily = aggregateToBucketEnds(points, 'day');

  const current = await db
    .prepare(
      `SELECT collected_at, followers FROM snapshots WHERE account_id = ? ORDER BY collected_at DESC LIMIT 1`
    )
    .bind(accountId)
    .first<SeriesPoint>();

  let dayDelta: number | null = null;
  let dayPct: number | null = null;
  if (current) {
    const cutoff = new Date(new Date(current.collected_at).getTime() - DAY_MS).toISOString();
    const prev = await db
      .prepare(
        `SELECT followers FROM snapshots WHERE account_id = ? AND collected_at <= ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(accountId, cutoff)
      .first<{ followers: number }>();
    if (prev) {
      dayDelta = current.followers - prev.followers;
      dayPct = prev.followers !== 0 ? dayDelta / prev.followers : null;
    }
  }

  const { results: posts } = await db
    .prepare(
      `SELECT id, external_id, url, posted_at FROM posts WHERE account_id = ?
       ORDER BY posted_at DESC, id DESC LIMIT 3`
    )
    .bind(accountId)
    .all<{ id: number; external_id: string; url: string | null; posted_at: string | null }>();

  const latestPosts: MonitorPost[] = [];
  for (const p of posts ?? []) {
    const row = await db
      .prepare(
        `SELECT likes FROM post_snapshots WHERE post_id = ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(p.id)
      .first<{ likes: number | null }>();
    latestPosts.push({
      external_id: p.external_id,
      posted_at: p.posted_at,
      url: p.url,
      likes: row ? row.likes : null,
    });
  }

  return {
    account_id: account.id,
    handle: account.handle,
    display_name: account.display_name,
    followers: current ? current.followers : null,
    collected_at: current ? current.collected_at : null,
    day_delta: dayDelta,
    day_pct: dayPct,
    latest_posts: latestPosts,
    sparkline: daily.map((p) => p.followers),
  };
}

// ---- /ui/audience ・ /api/audience(v9 Phase A-1)----

export interface AudienceBucket {
  bucket: string;
  value: number;
}

export interface AudienceStats {
  collected_at: string | null;
  kinds: {
    demographics_age: AudienceBucket[];
    demographics_gender: AudienceBucket[];
    demographics_city: AudienceBucket[];
    online_followers: AudienceBucket[];
  };
}

const AUDIENCE_KINDS = [
  'demographics_age',
  'demographics_gender',
  'demographics_city',
  'online_followers',
] as const;

/**
 * kind ごとに最新 collected_at のバケット群(value 降順)を返す。
 * データが一件も無ければ collected_at=null・kinds は4キーとも空配列。
 */
export async function getAudienceStats(
  db: D1Database,
  accountId: number
): Promise<AudienceStats | null> {
  const account = await fetchAccount(db, accountId);
  if (!account) return null;

  const kinds: AudienceStats['kinds'] = {
    demographics_age: [],
    demographics_gender: [],
    demographics_city: [],
    online_followers: [],
  };
  let latestCollectedAt: string | null = null;

  for (const kind of AUDIENCE_KINDS) {
    const latest = await db
      .prepare(
        `SELECT collected_at FROM audience_stats
         WHERE account_id = ? AND kind = ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(accountId, kind)
      .first<{ collected_at: string }>();
    if (!latest) continue;

    if (latestCollectedAt === null || latest.collected_at > latestCollectedAt) {
      latestCollectedAt = latest.collected_at;
    }

    const { results } = await db
      .prepare(
        `SELECT bucket, value FROM audience_stats
         WHERE account_id = ? AND kind = ? AND collected_at = ?
         ORDER BY value DESC`
      )
      .bind(accountId, kind, latest.collected_at)
      .all<AudienceBucket>();
    kinds[kind] = results ?? [];
  }

  return { collected_at: latestCollectedAt, kinds };
}

// ---- GAS スプレッドシート連携用の日次エクスポート(docs/gas-spreadsheet.md)----

export interface DailyExport {
  columns: string[];
  rows: (string | number | null)[][];
}

interface DailyRow {
  collected_at: string;
  followers: number;
  following: number | null;
  posts: number | null;
  reach: number | null;
  views: number | null;
}

/**
 * 1アカウントの日次エクスポート表を返す。各カレンダー日(UTC)の終値スナップショットを
 * 1行にし、前日との増減・前日比(%)を付与する。リーチ/ビューは Graph API 取得時のみ値が入り、
 * それ以外は null(= web 取得アカウント)。旧 インプレッション/プロフィール閲覧は Meta が
 * 2025-04-21 に完全廃止し、後継の views に統合された。
 *
 * 列: 日付 / フォロー数 / フォロワー数 / 増減 / 投稿数 / 増減 /
 *     リーチ数 / 増減 / 前日比 / ビュー数 / 増減 / 前日比
 * 前日比は比率(0.05 = +5%)。最初の行(前日なし)の増減・前日比は null。
 */
export async function getDailyExport(
  db: D1Database,
  accountId: number,
  from: string | null,
  to: string | null
): Promise<DailyExport> {
  let query = `SELECT collected_at, followers, following, posts, reach, views
               FROM snapshots WHERE account_id = ?`;
  const binds: unknown[] = [accountId];
  if (from) {
    query += ` AND collected_at >= ?`;
    binds.push(from);
  }
  if (to) {
    query += ` AND collected_at <= ?`;
    binds.push(to);
  }
  query += ` ORDER BY collected_at ASC`;

  const res = await db.prepare(query).bind(...binds).all<DailyRow>();

  // カレンダー日(UTC)ごとの終値。asc 入力なので Map は初出順(=時系列順)を保ち、値は後勝ち。
  const byDay = new Map<string, DailyRow>();
  for (const r of res.results ?? []) byDay.set(r.collected_at.slice(0, 10), r);

  const columns = [
    '日付', 'フォロー数', 'フォロワー数', '増減',
    '投稿数', '増減',
    'リーチ数', '増減', '前日比',
    'ビュー数', '増減', '前日比',
  ];

  const delta = (cur: number | null, prev: number | null | undefined): number | null =>
    cur == null || prev == null ? null : cur - prev;
  const pct = (cur: number | null, prev: number | null | undefined): number | null =>
    cur == null || prev == null || prev === 0 ? null : (cur - prev) / prev;

  const rows: (string | number | null)[][] = [];
  let prev: DailyRow | null = null;
  for (const [date, r] of byDay) {
    rows.push([
      date,
      r.following, r.followers, delta(r.followers, prev?.followers),
      r.posts, delta(r.posts, prev?.posts),
      r.reach, delta(r.reach, prev?.reach), pct(r.reach, prev?.reach),
      r.views, delta(r.views, prev?.views), pct(r.views, prev?.views),
    ]);
    prev = r;
  }

  return { columns, rows };
}
