import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { findAccount, type AccountRow } from '../lib/accounts';
import { getSettingsMap, getNumberSetting } from '../lib/settings';
import { checkAnomaly, fetchDailyDeltas, evaluatePostAlerts } from '../lib/anomaly';
import { emitEvent } from '../lib/events';

const ingest = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: POST /ingest は Bearer INGEST_SECRET
ingest.use('*', requireBearer('INGEST_SECRET'));

interface IngestPostInput {
  external_id: string;
  url?: string | null;
  posted_at?: string | null;
  media_type?: string | null;
  caption_head?: string | null;
  caption_full?: string | null;
  thumbnail_url?: string | null;
  likes?: number | null;
  comments?: number | null;
  views?: number | null;
  reach?: number | null;
  impressions?: number | null;
  saved?: number | null;
  // docs/insights-reports-plan.md §2.1 (Graph API 経路のみ。follows/profile_visits は
  // フィード投稿のみ、watch time 2種はリールのみ)。
  follows?: number | null;
  profile_visits?: number | null;
  shares?: number | null;
  total_interactions?: number | null;
  avg_watch_time_ms?: number | null;
  total_watch_time_ms?: number | null;
}

interface IngestSnapshotInput {
  platform: string;
  handle: string;
  collected_at: string;
  followers: number;
  following?: number | null;
  posts?: number | null;
  // アカウントレベル日次 Insights (Graph API 取得時のみ。web は null)。
  // impressions/profile_views は Meta が 2025-04-21 に完全廃止、後継の views に統合された。
  // 型としては残すが使わない (snapshots への書込は行わない)。
  reach?: number | null;
  impressions?: number | null;
  profile_views?: number | null;
  views?: number | null;
  // docs/insights-reports-plan.md §2.1 のアカウント日次 Insights 追加分。
  follows_gained?: number | null;
  follows_lost?: number | null;
  accounts_engaged?: number | null;
  total_interactions?: number | null;
  source?: string | null;
  recent_posts?: IngestPostInput[];
  // docs/insights-reports-plan.md §2.1: フォロワー属性・オンライン時間帯。
  // kind は 'demographics_age'|'demographics_gender'|'demographics_city'|'online_followers'
  // を想定するが検証は緩く(文字列なら通す)、collected_at は snapshot の値を使う。
  audience_stats?: Array<{ kind: string; bucket: string; value: number }>;
}

interface IngestRunInput {
  platform: string;
  handle: string;
  ran_at: string;
  status: 'ok' | 'fail';
  followers?: number | null;
  error?: string | null;
  latency_ms?: number | null;
}

interface IngestBody {
  snapshots?: IngestSnapshotInput[];
  runs?: IngestRunInput[];
}

function isValidSnapshot(s: unknown): s is IngestSnapshotInput {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.platform === 'string' &&
    typeof o.handle === 'string' &&
    typeof o.collected_at === 'string' &&
    typeof o.followers === 'number'
  );
}

function isValidRun(r: unknown): r is IngestRunInput {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.platform === 'string' &&
    typeof o.handle === 'string' &&
    typeof o.ran_at === 'string' &&
    (o.status === 'ok' || o.status === 'fail')
  );
}

ingest.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as IngestBody | null;
  if (!body || (!body.snapshots && !body.runs)) {
    return c.json({ error: 'body must include snapshots[] and/or runs[]' }, 400);
  }

  const snapshots = body.snapshots ?? [];
  const runs = body.runs ?? [];

  for (const s of snapshots) {
    if (!isValidSnapshot(s)) {
      return c.json({ error: 'invalid snapshot entry (platform/handle/collected_at/followers required)' }, 400);
    }
  }
  for (const r of runs) {
    if (!isValidRun(r)) {
      return c.json({ error: "invalid run entry (platform/handle/ran_at/status('ok'|'fail') required)" }, 400);
    }
  }

  const db = c.env.DB;

  // 未登録 handle は 400(自動作成しない)。事前に全件解決してから書込を始める。
  const accountCache = new Map<string, AccountRow>();
  const unknown: Array<{ platform: string; handle: string }> = [];

  const pairs = new Map<string, { platform: string; handle: string }>();
  for (const s of snapshots) pairs.set(`${s.platform}:${s.handle}`, { platform: s.platform, handle: s.handle });
  for (const r of runs) pairs.set(`${r.platform}:${r.handle}`, { platform: r.platform, handle: r.handle });

  for (const [key, { platform, handle }] of pairs) {
    const account = await findAccount(db, platform, handle);
    if (!account) {
      unknown.push({ platform, handle });
    } else {
      accountCache.set(key, account);
    }
  }

  if (unknown.length > 0) {
    return c.json({ error: 'unknown_accounts', accounts: unknown }, 400);
  }

  const settingsMap = await getSettingsMap(db);
  const pctThreshold = getNumberSetting(settingsMap, 'anomaly_pct_threshold', 0.1);
  const absMin = getNumberSetting(settingsMap, 'anomaly_abs_min', 50);
  const sigma = getNumberSetting(settingsMap, 'anomaly_sigma', 3);

  let snapshotsInserted = 0;
  let snapshotsDuplicate = 0;
  let postsUpserted = 0;
  let postSnapshotsInserted = 0;
  let audienceStatsInserted = 0;
  let eventsCreated = 0;

  for (const s of snapshots) {
    const account = accountCache.get(`${s.platform}:${s.handle}`)!;

    // 直前(collected_at より前で最新)のスナップショットを、挿入前に取得しておく
    const prev = await db
      .prepare(
        `SELECT followers FROM snapshots WHERE account_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(account.id, s.collected_at)
      .first<{ followers: number }>();

    const insertRes = await db
      .prepare(
        `INSERT INTO snapshots (account_id, collected_at, followers, following, posts, reach, views,
                                follows_gained, follows_lost, accounts_engaged, total_interactions, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, collected_at) DO NOTHING`
      )
      .bind(
        account.id,
        s.collected_at,
        s.followers,
        s.following ?? null,
        s.posts ?? null,
        s.reach ?? null,
        s.views ?? null,
        s.follows_gained ?? null,
        s.follows_lost ?? null,
        s.accounts_engaged ?? null,
        s.total_interactions ?? null,
        s.source ?? null
      )
      .run();

    const wasInserted = insertRes.meta.changes > 0;
    if (wasInserted) {
      snapshotsInserted += 1;
    } else {
      snapshotsDuplicate += 1;
    }

    if (wasInserted && prev) {
      // σベース閾値(docs/insights-reports-plan.md §3-5)。日次系列が薄いときは
      // checkAnomaly 内で従来ルール(pct + absMin)にフォールバックする。
      const dailyDeltas = await fetchDailyDeltas(db, account.id, s.collected_at);
      const anomaly = checkAnomaly({
        prevFollowers: prev.followers,
        newFollowers: s.followers,
        pctThreshold,
        absMin,
        dailyDeltas,
        sigma,
      });
      if (anomaly.isAnomaly) {
        const sign = anomaly.delta >= 0 ? '+' : '';
        const pctLabel = Number.isFinite(anomaly.pct) ? `${(anomaly.pct * 100).toFixed(1)}%` : 'N/A';
        await emitEvent(db, {
          type: 'anomaly',
          accountId: account.id,
          message: `@${s.handle} フォロワー ${sign}${anomaly.delta} (${pctLabel}) (${prev.followers}→${s.followers})`,
          payload: {
            prev: prev.followers,
            new: s.followers,
            delta: anomaly.delta,
            pct: anomaly.pct,
            threshold: anomaly.threshold,
            mode: anomaly.mode,
          },
        });
        eventsCreated += 1;
      }
    }

    for (const p of s.recent_posts ?? []) {
      // 初回は INSERT。既存投稿は thumbnail_url(署名付きで失効する)/ caption を
      // 最新値へ更新する。COALESCE で新値が null のときは既存値を維持。
      await db
        .prepare(
          `INSERT INTO posts (account_id, external_id, url, posted_at, media_type, caption_head, caption_full, thumbnail_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, external_id) DO UPDATE SET
             url = COALESCE(excluded.url, posts.url),
             posted_at = COALESCE(excluded.posted_at, posts.posted_at),
             media_type = COALESCE(excluded.media_type, posts.media_type),
             caption_head = COALESCE(excluded.caption_head, posts.caption_head),
             caption_full = COALESCE(excluded.caption_full, posts.caption_full),
             thumbnail_url = COALESCE(excluded.thumbnail_url, posts.thumbnail_url)`
        )
        .bind(
          account.id,
          p.external_id,
          p.url ?? null,
          p.posted_at ?? null,
          p.media_type ?? null,
          p.caption_head ?? null,
          p.caption_full ?? null,
          p.thumbnail_url ?? null
        )
        .run();
      postsUpserted += 1;

      const postRow = await db
        .prepare(`SELECT id FROM posts WHERE account_id = ? AND external_id = ?`)
        .bind(account.id, p.external_id)
        .first<{ id: number }>();
      if (!postRow) continue; // 理論上到達しない

      const postSnapRes = await db
        .prepare(
          `INSERT INTO post_snapshots (post_id, collected_at, likes, comments, views, reach, impressions, saved,
                                       follows, profile_visits, shares, total_interactions,
                                       avg_watch_time_ms, total_watch_time_ms, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (post_id, collected_at) DO NOTHING`
        )
        .bind(
          postRow.id,
          s.collected_at,
          p.likes ?? null,
          p.comments ?? null,
          p.views ?? null,
          p.reach ?? null,
          p.impressions ?? null,
          p.saved ?? null,
          p.follows ?? null,
          p.profile_visits ?? null,
          p.shares ?? null,
          p.total_interactions ?? null,
          p.avg_watch_time_ms ?? null,
          p.total_watch_time_ms ?? null,
          s.source ?? null
        )
        .run();
      if (postSnapRes.meta.changes > 0) postSnapshotsInserted += 1;
    }

    // フォロワー属性・オンライン時間帯(audience_stats)。UNIQUE 重複は無視。
    for (const a of s.audience_stats ?? []) {
      if (
        !a ||
        typeof a.kind !== 'string' ||
        typeof a.bucket !== 'string' ||
        typeof a.value !== 'number'
      ) {
        continue; // 検証は緩く、壊れた要素だけ黙って捨てる
      }
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO audience_stats (account_id, kind, bucket, value, collected_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(account.id, a.kind, a.bucket, a.value, s.collected_at)
        .run();
      if (res.meta.changes > 0) audienceStatsInserted += 1;
    }

    // 投稿の急伸/不調アラート(docs/insights-reports-plan.md §3-5)。
    // managed アカウントの投稿スナップショット書込後にインライン評価する。
    if (account.managed === 1 && (s.recent_posts?.length ?? 0) > 0) {
      const alerts = await evaluatePostAlerts(db, account, s.collected_at, settingsMap);
      eventsCreated += alerts.eventsCreated;
    }
  }

  let runsRecorded = 0;
  for (const r of runs) {
    const account = accountCache.get(`${r.platform}:${r.handle}`)!;
    await db
      .prepare(
        `INSERT INTO collection_runs (account_id, ran_at, status, followers, error, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(account.id, r.ran_at, r.status, r.followers ?? null, r.error ?? null, r.latency_ms ?? null)
      .run();
    runsRecorded += 1;

    if (r.status === 'fail') {
      await emitEvent(db, {
        type: 'collect_fail',
        accountId: account.id,
        message: `@${r.handle} 収集失敗: ${r.error ?? '(no error message)'}`,
        payload: { error: r.error ?? null, ran_at: r.ran_at },
      });
      eventsCreated += 1;
    }
  }

  return c.json({
    ok: true,
    snapshots_inserted: snapshotsInserted,
    snapshots_duplicate: snapshotsDuplicate,
    posts_upserted: postsUpserted,
    post_snapshots_inserted: postSnapshotsInserted,
    audience_stats_inserted: audienceStatsInserted,
    runs_recorded: runsRecorded,
    events_created: eventsCreated,
  });
});

export default ingest;
