/**
 * docs/insights-reports-plan.md §3-§4: 日次/週次/月次レポートの集計・生成・読取。
 *
 * 期間は JST 暦日基準。JST日 D = [D-1日15:00 UTC, D日15:00 UTC)。
 * metrics_json の形(キー名)は /ui/report 実装と共有する契約なので変えないこと。
 * 数値はすべてここで確定し、LLM は解釈のみ(llm.ts)。LLM 失敗時も metrics
 * だけで reports に保存する(講評欠落でレポート自体を失わない)。
 */
import type { Env } from '../types';
import { listAccounts, type AccountRow } from './accounts';
import { median } from './anomaly';
import { selectProvider, generateCommentary, type LlmCommentary } from './llm';
import { getAudienceStats, type AudienceStats } from './analytics';
import { emitEvent } from './events';
import { getSettingsMap } from './settings';

export type ReportKind = 'daily' | 'weekly' | 'monthly';

export function isReportKind(v: string | null | undefined): v is ReportKind {
  return v === 'daily' || v === 'weekly' || v === 'monthly';
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const JST_OFFSET_MS = 9 * HOUR_MS;

// ---- 期間計算(JST 暦日)----

export interface ReportPeriod {
  kind: ReportKind;
  start: string; // JST 'YYYY-MM-DD'(inclusive)
  end: string; // JST 'YYYY-MM-DD'(inclusive)
  utcFrom: string; // snapshots 等の抽出範囲 [utcFrom, utcTo)
  utcTo: string;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** JST暦日 'YYYY-MM-DD' の JST 0:00 を UTC ms で返す(= 前日 15:00Z)。 */
function jstMidnightMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) - JST_OFFSET_MS;
}

/** 現在時刻の JST 暦日 'YYYY-MM-DD'。 */
export function jstTodayString(now: Date = new Date()): string {
  return isoDate(now.getTime() + JST_OFFSET_MS);
}

function buildPeriod(kind: ReportKind, start: string, end: string): ReportPeriod {
  return {
    kind,
    start,
    end,
    utcFrom: new Date(jstMidnightMs(start)).toISOString(),
    utcTo: new Date(jstMidnightMs(end) + DAY_MS).toISOString(),
  };
}

/** cron 用: 直前の期間(daily=前日 / weekly=前週月〜日 / monthly=前月)を JST 基準で返す。 */
export function previousPeriod(kind: ReportKind, now: Date = new Date()): ReportPeriod {
  // UTC getter を JST 値として読むためのシフト
  const j = new Date(now.getTime() + JST_OFFSET_MS);
  const y = j.getUTCFullYear();
  const m = j.getUTCMonth();
  const d = j.getUTCDate();
  if (kind === 'daily') {
    const day = isoDate(Date.UTC(y, m, d - 1));
    return buildPeriod('daily', day, day);
  }
  if (kind === 'weekly') {
    const dow = j.getUTCDay(); // 0=日
    const thisMonday = Date.UTC(y, m, d - ((dow + 6) % 7));
    return buildPeriod('weekly', isoDate(thisMonday - 7 * DAY_MS), isoDate(thisMonday - DAY_MS));
  }
  return buildPeriod('monthly', isoDate(Date.UTC(y, m - 1, 1)), isoDate(Date.UTC(y, m, 0)));
}

/** regenerate 用: period_start から期間を復元する(weekly=start+6日、monthly=その月末まで)。 */
export function periodFromStart(kind: ReportKind, start: string): ReportPeriod | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const ms = Date.parse(`${start}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  if (kind === 'daily') return buildPeriod('daily', start, start);
  if (kind === 'weekly') return buildPeriod('weekly', start, isoDate(ms + 6 * DAY_MS));
  const d = new Date(ms);
  return buildPeriod('monthly', start, isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/**
 * v9 Phase B-1: 与えられた期間の「直前の同長期間」を返す(daily=前日、weekly=前週、
 * monthly=前月)。previousPeriod/periodFromStart と同じ流儀(JST暦日文字列で計算)。
 */
function previousPeriodOf(period: ReportPeriod): ReportPeriod {
  const startMs = Date.parse(`${period.start}T00:00:00.000Z`);
  if (period.kind === 'daily') {
    const day = isoDate(startMs - DAY_MS);
    return buildPeriod('daily', day, day);
  }
  if (period.kind === 'weekly') {
    return buildPeriod('weekly', isoDate(startMs - 7 * DAY_MS), isoDate(startMs - DAY_MS));
  }
  const d = new Date(startMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // period.start は月初なので、その前月を求める
  return buildPeriod('monthly', isoDate(Date.UTC(y, m - 1, 1)), isoDate(Date.UTC(y, m, 0)));
}

// ---- metrics_json の契約型(/ui/report 実装と共有。キー名変更禁止)----

export interface ReportKpi {
  followers: number;
  delta: number;
  reach: number;
  views: number;
  follows_gained: number;
  follows_lost: number;
  accounts_engaged: number;
  total_interactions: number;
}

export interface ReportContribution {
  external_id: string;
  caption_head: string;
  media_type: string;
  follows_delta: number;
}

export interface ReportEarly {
  h1: number | null;
  h3: number | null;
  h6: number | null;
  h24: number | null;
  h48: number | null;
}

export interface ReportPost {
  /** D1 posts.id。UI がサムネイル /img/:post_id を引くために持たせる(親裁定による契約追加)。 */
  post_id: number;
  external_id: string;
  url: string;
  posted_at: string;
  media_type: string;
  caption_head: string;
  reach: number;
  likes: number;
  comments: number;
  saved: number;
  shares: number;
  /** 投稿の累計フォロー獲得(最新スナップショットの値)。 */
  follows: number;
  /** この期間内に増えたフォロー(期間開始前の値との差)。contributions と同じ基準。 */
  follows_delta: number | null;
  profile_visits: number;
  views: number | null;
  avg_watch_time_ms: number | null;
  like_rate: number | null;
  save_rate: number | null;
  share_rate: number | null;
  baseline_multiple: number | null;
  early: ReportEarly;
}

export interface CrossByDow {
  dow: number; // 0=日(JST)
  avg_reach: number;
  avg_follows: number;
  count: number;
}

export interface CrossByHour {
  hour: number; // JST 3時間刻みのバケット開始(0,3,...,21)
  avg_reach: number;
  avg_follows: number;
  count: number;
}

export interface CrossByType {
  media_type: string;
  avg_reach: number;
  avg_follows: number;
  count: number;
}

export interface ReportOther {
  handle: string;
  display_name: string;
  followers: number;
  delta: number;
}

export interface CrossByTheme {
  theme: string; // theme NULL は「未分類」
  avg_reach: number;
  avg_follows: number;
  count: number;
}

export interface CrossByHashtag {
  hashtag: string;
  avg_reach: number;
  avg_follows: number;
  count: number;
}

export type CaptionLengthBucket = 'short' | 'medium' | 'long';

export interface CrossByCaptionLength {
  bucket: CaptionLengthBucket;
  avg_reach: number;
  avg_follows: number;
  count: number;
}

/** v9 Phase B-1: 前期間比較(daily/weekly/monthly すべて)。 */
export interface ReportCompare {
  prev: ReportKpi;
  pct: {
    followers: number | null;
    reach: number | null;
    views: number | null;
    follows_gained: number | null;
  };
}

/** v9 Phase B-1: 直近12期間のフォロワー終値・純増系列(weekly/monthly のみ)。 */
export interface TrendPoint {
  period_start: string;
  followers: number;
  delta: number;
}

/** v9 Phase B-3: 直近30日の日次終値の線形回帰によるフォロワー成長予測。 */
export interface ReportForecast {
  daily_pace: number;
  month_end: { date: string; followers: number };
  goal: number | null;
  goal_eta: string | null;
  /** 目標を既に達成済みか(goal 未設定時は false)。goal_eta=null との区別に使う。 */
  goal_achieved: boolean;
}

export interface ReportMetrics {
  period: { kind: ReportKind; start: string; end: string };
  kpi: ReportKpi;
  contributions: ReportContribution[];
  posts: ReportPost[];
  /** v10: 日報のみ。期間外だが直近の投稿(最大5件)。UI 表示用で LLM 講評の入力には含めない。 */
  recent_posts: ReportPost[];
  cross: {
    by_dow: CrossByDow[];
    by_hour: CrossByHour[];
    by_type: CrossByType[];
    by_theme: CrossByTheme[];
    by_hashtag: CrossByHashtag[];
    by_caption_length: CrossByCaptionLength[];
  };
  others: ReportOther[];
  /** weekly/monthly のみ。daily は null。 */
  audience: AudienceStats | null;
  /** 前期間にスナップショットが1件も無ければ null。 */
  compare: ReportCompare | null;
  /** weekly/monthly のみ。daily は null。 */
  trend: TrendPoint[] | null;
  /** 直近30日の日次点が7点未満なら null。 */
  forecast: ReportForecast | null;
}

// ---- 集計 ----

/** ISO 時刻の JST 暦日キー。 */
function jstDayOf(iso: string): string {
  return isoDate(Date.parse(iso) + JST_OFFSET_MS);
}

interface SnapRow {
  collected_at: string;
  followers: number;
  reach: number | null;
  views: number | null;
  follows_gained: number | null;
  follows_lost: number | null;
  accounts_engaged: number | null;
  total_interactions: number | null;
}

interface PostRow {
  id: number;
  external_id: string;
  url: string | null;
  posted_at: string | null;
  media_type: string | null;
  caption_head: string | null;
  follows_before: number | null;
  follows_end: number | null;
}

interface PostLatestRow {
  likes: number | null;
  comments: number | null;
  views: number | null;
  reach: number | null;
  saved: number | null;
  shares: number | null;
  follows: number | null;
  profile_visits: number | null;
  avg_watch_time_ms: number | null;
}

/** 投稿の期間 follows 増分。期間内に値が無ければ null、期間前の値が無ければ期間内最新値をそのまま増分とみなす。 */
function followsDelta(row: PostRow): number | null {
  if (row.follows_end === null) return null;
  return row.follows_end - (row.follows_before ?? 0);
}

function rate(value: number | null, reach: number | null): number | null {
  if (value === null || reach === null || reach <= 0) return null;
  return value / reach;
}

function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

interface KpiComputation {
  kpi: ReportKpi;
  /** 期間内に snapshot が1件でもあったか(v9 compare: 前期間データ有無判定に使う)。 */
  hasSnapshots: boolean;
}

/** 期間内の snapshot から kpi(followers/delta と日次値の合計)を集計する。compare でも使い回す。 */
async function computeKpiForPeriod(
  db: D1Database,
  accountId: number,
  period: ReportPeriod
): Promise<KpiComputation> {
  const { results: snaps } = await db
    .prepare(
      `SELECT collected_at, followers, reach, views, follows_gained, follows_lost, accounts_engaged, total_interactions
       FROM snapshots WHERE account_id = ? AND collected_at >= ? AND collected_at < ?
       ORDER BY collected_at ASC`
    )
    .bind(accountId, period.utcFrom, period.utcTo)
    .all<SnapRow>();
  const snapList = snaps ?? [];

  const baseline = await db
    .prepare(
      `SELECT followers FROM snapshots WHERE account_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`
    )
    .bind(accountId, period.utcFrom)
    .first<{ followers: number }>();

  // JST日ごとの最新値(昇順入力なので後勝ち)。スナップショットは1日複数あるため。
  const byJstDay = new Map<string, SnapRow>();
  for (const r of snapList) byJstDay.set(jstDayOf(r.collected_at), r);

  const kpi: ReportKpi = {
    followers: 0,
    delta: 0,
    reach: 0,
    views: 0,
    follows_gained: 0,
    follows_lost: 0,
    accounts_engaged: 0,
    total_interactions: 0,
  };
  for (const r of byJstDay.values()) {
    kpi.reach += r.reach ?? 0;
    kpi.views += r.views ?? 0;
    kpi.follows_gained += r.follows_gained ?? 0;
    kpi.follows_lost += r.follows_lost ?? 0;
    kpi.accounts_engaged += r.accounts_engaged ?? 0;
    kpi.total_interactions += r.total_interactions ?? 0;
  }
  const endFollowers =
    snapList.length > 0 ? snapList[snapList.length - 1].followers : baseline?.followers ?? 0;
  const baseFollowers = baseline?.followers ?? snapList[0]?.followers ?? endFollowers;
  kpi.followers = endFollowers;
  kpi.delta = endFollowers - baseFollowers;

  return { kpi, hasSnapshots: snapList.length > 0 };
}

/** v9 Phase B-1: pct = (cur - prev) / prev。prev が 0 または欠損なら null。 */
function pctOf(cur: number, prev: number): number | null {
  return prev !== 0 ? (cur - prev) / prev : null;
}

/** 1 managed アカウント分の metrics_json を集計する。 */
export async function buildReportMetrics(
  db: D1Database,
  account: AccountRow,
  period: ReportPeriod,
  now: Date = new Date()
): Promise<ReportMetrics> {
  // ---- KPI: 期間終値と増減、日次値(JST日ごとの最新スナップショット)の合計 ----
  const { kpi } = await computeKpiForPeriod(db, account.id, period);

  // ---- v9 Phase B-1: 前期間比較。前期間に snapshot が1件も無ければ compare 全体を null ----
  const prevPeriod = previousPeriodOf(period);
  const { kpi: prevKpi, hasSnapshots: prevHasSnapshots } = await computeKpiForPeriod(
    db,
    account.id,
    prevPeriod
  );
  const compare: ReportMetrics['compare'] = prevHasSnapshots
    ? {
        prev: prevKpi,
        pct: {
          followers: pctOf(kpi.followers, prevKpi.followers),
          reach: pctOf(kpi.reach, prevKpi.reach),
          views: pctOf(kpi.views, prevKpi.views),
          follows_gained: pctOf(kpi.follows_gained, prevKpi.follows_gained),
        },
      }
    : null;

  // ---- 投稿別 follows 増分(期間開始前の最新値との差、無ければ期間内最新値)----
  const { results: postRows } = await db
    .prepare(
      `SELECT p.id, p.external_id, p.url, p.posted_at, p.media_type, p.caption_head,
         (SELECT ps.follows FROM post_snapshots ps
           WHERE ps.post_id = p.id AND ps.collected_at < ? AND ps.follows IS NOT NULL
           ORDER BY ps.collected_at DESC LIMIT 1) AS follows_before,
         (SELECT ps.follows FROM post_snapshots ps
           WHERE ps.post_id = p.id AND ps.collected_at >= ? AND ps.collected_at < ? AND ps.follows IS NOT NULL
           ORDER BY ps.collected_at DESC LIMIT 1) AS follows_end
       FROM posts p WHERE p.account_id = ?`
    )
    .bind(period.utcFrom, period.utcFrom, period.utcTo, account.id)
    .all<PostRow>();
  const allPosts = postRows ?? [];

  const contributions: ReportContribution[] = allPosts
    .map((p) => ({ p, delta: followsDelta(p) }))
    .filter((x): x is { p: PostRow; delta: number } => x.delta !== null && x.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .map(({ p, delta }) => ({
      external_id: p.external_id,
      caption_head: p.caption_head ?? '',
      media_type: p.media_type ?? '',
      follows_delta: delta,
    }));

  // ---- 投稿パフォーマンス表: 期間内投稿 + 期間内 follows 増分>0 の投稿 ----
  const fromMs = Date.parse(period.utcFrom);
  const toMs = Date.parse(period.utcTo);
  const postedInPeriod = (p: PostRow): boolean => {
    if (!p.posted_at) return false;
    const ms = Date.parse(p.posted_at);
    return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
  };
  const selected = allPosts
    .filter((p) => postedInPeriod(p) || (followsDelta(p) ?? 0) > 0)
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''));

  // v10: 日報は期間内投稿が0件になりがちなので、期間外の直近投稿(最大5件)を別枠で添える。
  // UI 表示専用で、LLM 講評の入力(buildLlmSummary)には含めない。
  const recentSelected: PostRow[] =
    period.kind === 'daily'
      ? allPosts
          .filter((p) => p.posted_at && !selected.includes(p))
          .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))
          .slice(0, 5)
      : [];

  // ベースライン: 直近30日(期間終端基準)に投稿された投稿の reach 中央値
  const baselineFrom = new Date(toMs - 30 * DAY_MS).toISOString();
  const { results: baselineRows } = await db
    .prepare(
      `SELECT (SELECT ps.reach FROM post_snapshots ps
          WHERE ps.post_id = p.id AND ps.collected_at < ? AND ps.reach IS NOT NULL
          ORDER BY ps.collected_at DESC LIMIT 1) AS reach
       FROM posts p WHERE p.account_id = ? AND p.posted_at >= ? AND p.posted_at < ?`
    )
    .bind(period.utcTo, account.id, baselineFrom, period.utcTo)
    .all<{ reach: number | null }>();
  const baselineMedian = median(
    (baselineRows ?? []).map((r) => r.reach).filter((v): v is number => v !== null)
  );

  const posts: ReportPost[] = [];
  const recentPosts: ReportPost[] = [];
  for (const p of [...selected, ...recentSelected]) {
    const dest = selected.includes(p) ? posts : recentPosts;
    // 最新スナップショット(全指標)を1本。
    const latest = await db
      .prepare(
        `SELECT likes, comments, views, reach, saved, shares, follows, profile_visits, avg_watch_time_ms
         FROM post_snapshots WHERE post_id = ? AND collected_at < ?
         ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(p.id, period.utcTo)
      .first<PostLatestRow>();

    // 初速: posted_at〜+48h の reach 系列を1本だけ取り、各 horizon をメモリ上で解決する
    // (以前は horizon ごとに1クエリ = 投稿あたり最大6本だった。§efficiency)。
    const early: ReportEarly = { h1: null, h3: null, h6: null, h24: null, h48: null };
    const postedMs = p.posted_at ? Date.parse(p.posted_at) : NaN;
    if (Number.isFinite(postedMs)) {
      const windowTo = new Date(postedMs + 48 * HOUR_MS).toISOString();
      const { results: earlyRows } = await db
        .prepare(
          `SELECT collected_at, reach FROM post_snapshots
           WHERE post_id = ? AND collected_at <= ? AND reach IS NOT NULL
           ORDER BY collected_at ASC`
        )
        .bind(p.id, windowTo)
        .all<{ collected_at: string; reach: number }>();
      const series = earlyRows ?? [];
      for (const [key, hours] of [['h1', 1], ['h3', 3], ['h6', 6], ['h24', 24], ['h48', 48]] as const) {
        const target = postedMs + hours * HOUR_MS;
        if (target > now.getTime()) continue; // まだ到来していない horizon は未確定
        const targetIso = new Date(target).toISOString();
        // target 以前で最新の reach(series は昇順)。
        let val: number | null = null;
        for (const r of series) {
          if (r.collected_at <= targetIso) val = r.reach;
          else break;
        }
        early[key] = val;
      }
    }

    const reach = latest?.reach ?? null;
    dest.push({
      post_id: p.id,
      external_id: p.external_id,
      url: p.url ?? '',
      posted_at: p.posted_at ?? '',
      media_type: p.media_type ?? '',
      caption_head: p.caption_head ?? '',
      reach: reach ?? 0,
      likes: latest?.likes ?? 0,
      comments: latest?.comments ?? 0,
      saved: latest?.saved ?? 0,
      shares: latest?.shares ?? 0,
      follows: latest?.follows ?? 0,
      follows_delta: followsDelta(p),
      profile_visits: latest?.profile_visits ?? 0,
      views: latest?.views ?? null,
      avg_watch_time_ms: latest?.avg_watch_time_ms ?? null,
      like_rate: rate(latest?.likes ?? null, reach),
      save_rate: rate(latest?.saved ?? null, reach),
      share_rate: rate(latest?.shares ?? null, reach),
      baseline_multiple:
        reach !== null && baselineMedian !== null && baselineMedian > 0
          ? reach / baselineMedian
          : null,
      early,
    });
  }

  // ---- クロス集計(weekly/monthly のみ): 直近90日の投稿を曜日/時刻帯/形式/テーマ/ハッシュタグ/文字数別に平均 ----
  const cross: ReportMetrics['cross'] = {
    by_dow: [],
    by_hour: [],
    by_type: [],
    by_theme: [],
    by_hashtag: [],
    by_caption_length: [],
  };
  if (period.kind !== 'daily') {
    const crossFrom = new Date(toMs - 90 * DAY_MS).toISOString();
    const { results: crossRows } = await db
      .prepare(
        `SELECT p.posted_at, p.media_type, p.theme, p.caption_full,
           (SELECT ps.reach FROM post_snapshots ps
             WHERE ps.post_id = p.id AND ps.collected_at < ? AND ps.reach IS NOT NULL
             ORDER BY ps.collected_at DESC LIMIT 1) AS reach,
           (SELECT ps.follows FROM post_snapshots ps
             WHERE ps.post_id = p.id AND ps.collected_at < ? AND ps.follows IS NOT NULL
             ORDER BY ps.collected_at DESC LIMIT 1) AS follows
         FROM posts p WHERE p.account_id = ? AND p.posted_at IS NOT NULL AND p.posted_at >= ? AND p.posted_at < ?`
      )
      .bind(period.utcTo, period.utcTo, account.id, crossFrom, period.utcTo)
      .all<{
        posted_at: string;
        media_type: string | null;
        theme: string | null;
        caption_full: string | null;
        reach: number | null;
        follows: number | null;
      }>();

    const byDow = new Map<number, { reach: number[]; follows: number[]; count: number }>();
    const byHour = new Map<number, { reach: number[]; follows: number[]; count: number }>();
    const byType = new Map<string, { reach: number[]; follows: number[]; count: number }>();
    const byTheme = new Map<string, { reach: number[]; follows: number[]; count: number }>();
    const byHashtag = new Map<string, { reach: number[]; follows: number[]; count: number }>();
    const byCaptionLength = new Map<CaptionLengthBucket, { reach: number[]; follows: number[]; count: number }>();
    const push = <K>(map: Map<K, { reach: number[]; follows: number[]; count: number }>, key: K, r: { reach: number | null; follows: number | null }) => {
      const g = map.get(key) ?? { reach: [], follows: [], count: 0 };
      g.count += 1;
      if (r.reach !== null) g.reach.push(r.reach);
      if (r.follows !== null) g.follows.push(r.follows);
      map.set(key, g);
    };
    for (const r of crossRows ?? []) {
      const jst = new Date(Date.parse(r.posted_at) + JST_OFFSET_MS);
      push(byDow, jst.getUTCDay(), r);
      push(byHour, Math.floor(jst.getUTCHours() / 3) * 3, r);
      push(byType, r.media_type ?? 'unknown', r);
      push(byTheme, r.theme ?? '未分類', r);
      // ハッシュタグは1投稿1回だけ数える(同一キャプション内の重複は無視)
      const tags = new Set((r.caption_full ?? '').match(/#[^\s#]+/gu) ?? []);
      for (const tag of tags) push(byHashtag, tag, r);
      const len = (r.caption_full ?? '').length;
      const bucket: CaptionLengthBucket = len < 100 ? 'short' : len <= 300 ? 'medium' : 'long';
      push(byCaptionLength, bucket, r);
    }
    const toEntry = (
      g: { reach: number[]; follows: number[]; count: number }
    ): { avg_reach: number; avg_follows: number; count: number } => ({
      avg_reach: Math.round(avg(g.reach)),
      avg_follows: Math.round(avg(g.follows) * 10) / 10,
      count: g.count,
    });
    cross.by_dow = [...byDow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dow, g]) => ({ dow, ...toEntry(g) }));
    cross.by_hour = [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, g]) => ({ hour, ...toEntry(g) }));
    cross.by_type = [...byType.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([media_type, g]) => ({ media_type, ...toEntry(g) }));
    cross.by_theme = [...byTheme.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([theme, g]) => ({ theme, ...toEntry(g) }));
    cross.by_hashtag = [...byHashtag.entries()]
      .filter(([, g]) => g.count >= 2)
      .map(([hashtag, g]) => ({ hashtag, ...toEntry(g) }))
      .sort((a, b) => b.avg_reach - a.avg_reach)
      .slice(0, 10);
    cross.by_caption_length = (['short', 'medium', 'long'] as const)
      .filter((b) => byCaptionLength.has(b))
      .map((b) => ({ bucket: b, ...toEntry(byCaptionLength.get(b)!) }));
  }

  // ---- 他アカウント(managed 以外の active)の期間フォロワー増減 ----
  const others: ReportOther[] = [];
  const accounts = await listAccounts(db, { activeOnly: true });
  for (const a of accounts) {
    if (a.managed === 1) continue;
    const end = await db
      .prepare(
        `SELECT followers FROM snapshots WHERE account_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(a.id, period.utcTo)
      .first<{ followers: number }>();
    if (!end) continue; // スナップショットが1件も無いアカウントは表示しない
    const base = await db
      .prepare(
        `SELECT followers FROM snapshots WHERE account_id = ? AND collected_at < ? ORDER BY collected_at DESC LIMIT 1`
      )
      .bind(a.id, period.utcFrom)
      .first<{ followers: number }>();
    others.push({
      handle: a.handle,
      display_name: a.display_name ?? '',
      followers: end.followers,
      delta: end.followers - (base?.followers ?? end.followers),
    });
  }

  // ---- v9 Phase A-1: オーディエンス(weekly/monthly のみ)----
  const audience = period.kind !== 'daily' ? await getAudienceStats(db, account.id) : null;

  // ---- v9 Phase B-1: トレンド(直近12期間の終値・純増。weekly/monthly のみ)----
  const trend = period.kind !== 'daily' ? await computeTrend(db, account.id, period) : null;

  // ---- v9 Phase B-3: 成長予測(全kind)----
  const settingsMap = await getSettingsMap(db);
  const followerGoalRaw = settingsMap['follower_goal'];
  const followerGoal =
    followerGoalRaw !== undefined && Number.isFinite(Number(followerGoalRaw))
      ? Number(followerGoalRaw)
      : null;
  const forecast = await computeForecast(db, account.id, period, followerGoal);

  return {
    period: { kind: period.kind, start: period.start, end: period.end },
    kpi,
    contributions,
    posts,
    recent_posts: recentPosts,
    cross,
    others,
    audience,
    compare,
    trend,
    forecast,
  };
}

/** v9 Phase B-1: 直近12期間(古い順、当期含む)の終値・純増系列。 */
async function computeTrend(
  db: D1Database,
  accountId: number,
  period: ReportPeriod
): Promise<TrendPoint[]> {
  const periods: ReportPeriod[] = [period];
  for (let i = 0; i < 11; i++) {
    periods.unshift(previousPeriodOf(periods[0]));
  }
  const points: TrendPoint[] = [];
  for (const p of periods) {
    const { kpi } = await computeKpiForPeriod(db, accountId, p);
    points.push({ period_start: p.start, followers: kpi.followers, delta: kpi.delta });
  }
  return points;
}

/** 最小二乗法による単回帰。 */
function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * v9 Phase B-3: 直近30日の日次終値(JST日)の線形回帰でフォロワー成長を予測する。
 * period.utcTo を基準時刻とする(過去期間の regenerate でも決定的に計算できるように)。
 * 日次点が7点未満なら null。
 */
async function computeForecast(
  db: D1Database,
  accountId: number,
  period: ReportPeriod,
  followerGoal: number | null
): Promise<ReportForecast | null> {
  const toMs = Date.parse(period.utcTo);
  const from = new Date(toMs - 30 * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT collected_at, followers FROM snapshots
       WHERE account_id = ? AND collected_at >= ? AND collected_at < ? ORDER BY collected_at ASC`
    )
    .bind(accountId, from, period.utcTo)
    .all<{ collected_at: string; followers: number }>();
  const rows = results ?? [];

  // JST日ごとの終値(昇順入力なので後勝ち。Map は初出順=時系列順を保つ)。
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(jstDayOf(r.collected_at), r.followers);
  const days = [...byDay.entries()];
  if (days.length < 7) return null;

  const firstDayMs = Date.parse(`${days[0][0]}T00:00:00.000Z`);
  const points = days.map(([day, followers]) => ({
    x: Math.round((Date.parse(`${day}T00:00:00.000Z`) - firstDayMs) / DAY_MS),
    y: followers,
  }));
  const { slope, intercept } = linearRegression(points);
  const dailyPace = Math.round(slope * 10) / 10;

  const [py, pm] = period.end.split('-').map(Number);
  const monthEndDate = isoDate(Date.UTC(py, pm, 0));
  const monthEndX = Math.round((Date.parse(`${monthEndDate}T00:00:00.000Z`) - firstDayMs) / DAY_MS);
  const monthEndFollowers = Math.max(0, Math.round(intercept + slope * monthEndX));

  const currentFollowers = days[days.length - 1][1];
  // 達成済みは goal_eta=null と区別する(「到達見込みが立たない」と逆の意味になるため)
  const goalAchieved = followerGoal !== null && currentFollowers >= followerGoal;
  let goalEta: string | null = null;
  if (followerGoal !== null && !goalAchieved && slope > 0) {
    const daysNeeded = Math.ceil((followerGoal - currentFollowers) / slope);
    const lastDayMs = Date.parse(`${days[days.length - 1][0]}T00:00:00.000Z`);
    goalEta = isoDate(lastDayMs + daysNeeded * DAY_MS);
  }

  return {
    daily_pace: dailyPace,
    month_end: { date: monthEndDate, followers: monthEndFollowers },
    goal: followerGoal,
    goal_eta: goalEta,
    goal_achieved: goalAchieved,
  };
}

// ---- 生成 + UPSERT ----

export interface GenerateResult {
  kind: ReportKind;
  period_start: string;
  period_end: string;
  accounts: number;
  /** 生成対象になった managed アカウントの id(regenerate のキャッシュパージ用)。 */
  account_ids: number[];
  saved: number;
  llm_ok: number;
  llm_failed: number;
}

/** LLM へ渡す縮約サマリー(トークン節約のため posts 等を上位のみに絞る)。 */
function buildLlmSummary(metrics: ReportMetrics): unknown {
  return {
    period: metrics.period,
    kpi: metrics.kpi,
    contributions: metrics.contributions.slice(0, 5),
    posts: metrics.posts.slice(0, 8).map((p) => ({
      caption_head: p.caption_head,
      media_type: p.media_type,
      posted_at: p.posted_at,
      reach: p.reach,
      likes: p.likes,
      saved: p.saved,
      shares: p.shares,
      follows: p.follows,
      like_rate: p.like_rate,
      save_rate: p.save_rate,
      baseline_multiple: p.baseline_multiple,
      early_h24_reach: p.early.h24,
    })),
    cross: metrics.cross,
    others_total_delta: metrics.others.reduce((a, o) => a + o.delta, 0),
  };
}

/**
 * 指定期間のレポートを managed アカウントごとに集計・講評生成し reports へ UPSERT する。
 * LLM 失敗(通信エラー/パース失敗)時は llm_json=null で metrics のみ保存する。
 */
export async function generateReportsForPeriod(env: Env, period: ReportPeriod): Promise<GenerateResult> {
  const db = env.DB;
  const managed = (await listAccounts(db, { activeOnly: true })).filter((a) => a.managed === 1);
  const provider = selectProvider(env);

  let saved = 0;
  let llmOk = 0;
  let llmFailed = 0;
  for (const account of managed) {
    const metrics = await buildReportMetrics(db, account, period);
    let llm: LlmCommentary | null = null;
    try {
      llm = await generateCommentary(provider, buildLlmSummary(metrics));
      if (!llm) {
        await emitEvent(db, {
          type: 'llm_fail',
          accountId: account.id,
          message: '講評のパース失敗',
        });
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`llm commentary failed (account=${account.handle}, ${period.kind} ${period.start}):`, e);
      await emitEvent(db, { type: 'llm_fail', accountId: account.id, message: detail });
      llm = null;
    }
    if (llm) llmOk += 1;
    else llmFailed += 1;

    await db
      .prepare(
        `INSERT INTO reports (kind, period_start, period_end, account_id, metrics_json, llm_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, period_start, account_id) DO UPDATE SET
           period_end = excluded.period_end,
           metrics_json = excluded.metrics_json,
           llm_json = excluded.llm_json,
           created_at = datetime('now')`
      )
      .bind(
        period.kind,
        period.start,
        period.end,
        account.id,
        JSON.stringify(metrics),
        llm ? JSON.stringify(llm) : null
      )
      .run();
    saved += 1;
  }

  return {
    kind: period.kind,
    period_start: period.start,
    period_end: period.end,
    accounts: managed.length,
    account_ids: managed.map((a) => a.id),
    saved,
    llm_ok: llmOk,
    llm_failed: llmFailed,
  };
}

// ---- 読取(routes/reports.ts と /ui 側から共用)----

export interface ReportListItem {
  id: number;
  kind: ReportKind;
  period_start: string;
  period_end: string;
  account_id: number;
  handle: string;
  has_llm: boolean;
  created_at: string;
}

export async function listReports(
  db: D1Database,
  opts: { kind?: ReportKind | null; limit?: number }
): Promise<ReportListItem[]> {
  let query = `SELECT r.id, r.kind, r.period_start, r.period_end, r.account_id, a.handle,
                      (r.llm_json IS NOT NULL) AS has_llm, r.created_at
               FROM reports r JOIN accounts a ON a.id = r.account_id`;
  const binds: unknown[] = [];
  if (opts.kind) {
    query += ` WHERE r.kind = ?`;
    binds.push(opts.kind);
  }
  query += ` ORDER BY r.period_start DESC, r.kind, r.account_id LIMIT ?`;
  binds.push(opts.limit ?? 30);

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<Omit<ReportListItem, 'has_llm'> & { has_llm: number }>();
  return (results ?? []).map((r) => ({ ...r, has_llm: r.has_llm === 1 }));
}

export interface ReportDetail {
  kind: ReportKind;
  period_start: string;
  period_end: string;
  account_id: number;
  handle: string;
  metrics: ReportMetrics;
  llm: LlmCommentary | null;
  created_at: string;
}

/** account_id 省略時は最小の account_id のレポート(現状 managed は1つの想定)。 */
export async function getReport(
  db: D1Database,
  kind: ReportKind,
  periodStart: string,
  accountId: number | null = null
): Promise<ReportDetail | null> {
  let query = `SELECT r.kind, r.period_start, r.period_end, r.account_id, a.handle,
                      r.metrics_json, r.llm_json, r.created_at
               FROM reports r JOIN accounts a ON a.id = r.account_id
               WHERE r.kind = ? AND r.period_start = ?`;
  const binds: unknown[] = [kind, periodStart];
  if (accountId !== null) {
    query += ` AND r.account_id = ?`;
    binds.push(accountId);
  }
  query += ` ORDER BY r.account_id LIMIT 1`;

  const row = await db
    .prepare(query)
    .bind(...binds)
    .first<{
      kind: ReportKind;
      period_start: string;
      period_end: string;
      account_id: number;
      handle: string;
      metrics_json: string;
      llm_json: string | null;
      created_at: string;
    }>();
  if (!row) return null;
  return {
    kind: row.kind,
    period_start: row.period_start,
    period_end: row.period_end,
    account_id: row.account_id,
    handle: row.handle,
    metrics: JSON.parse(row.metrics_json) as ReportMetrics,
    llm: row.llm_json ? (JSON.parse(row.llm_json) as LlmCommentary) : null,
    created_at: row.created_at,
  };
}
