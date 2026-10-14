/**
 * 計画書 §5.6 + docs/insights-reports-plan.md §3-5: 急変動判定。
 *
 * フォロワー急変: 過去30日の日次増減が十分あれば閾値 = max(10, σ × anomaly_sigma)
 * のσベース判定。日次系列が不足しているときは従来ルール
 * (pct >= anomaly_pct_threshold かつ |delta| >= anomaly_abs_min)にフォールバック。
 * 投稿の急伸(post_spike)/不調(slump)は evaluatePostAlerts()(ingest 書込後に呼ぶ)。
 */
import type { AccountRow } from './accounts';
import { getNumberSetting, type SettingsMap } from './settings';
import { emitEvent } from './events';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const JST_OFFSET_MS = 9 * HOUR_MS;

// ---- 純関数(統計)----

/** 母標準偏差。 */
export function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** 中央値。空配列は null。 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---- フォロワー急変 ----

/** σベース判定に必要な最低日次点数(これ未満は従来ルールへフォールバック)。 */
const MIN_DELTAS_FOR_SIGMA = 5;

export interface AnomalyCheckInput {
  prevFollowers: number;
  newFollowers: number;
  pctThreshold: number;
  absMin: number;
  /** 過去30日の日次増減系列(fetchDailyDeltas)。省略/不足時は従来ルール。 */
  dailyDeltas?: number[];
  /** σ倍率(settings: anomaly_sigma、既定3)。 */
  sigma?: number;
}

export interface AnomalyResult {
  isAnomaly: boolean;
  delta: number;
  pct: number;
  /** 判定に使った絶対値閾値(sigma モード時は max(10, σ×sigma)、legacy は absMin)。 */
  threshold: number;
  mode: 'sigma' | 'legacy';
}

export function checkAnomaly(input: AnomalyCheckInput): AnomalyResult {
  const { prevFollowers, newFollowers, pctThreshold, absMin, dailyDeltas, sigma } = input;
  const delta = newFollowers - prevFollowers;
  const pct = prevFollowers === 0 ? (delta === 0 ? 0 : Infinity) : Math.abs(delta) / prevFollowers;

  if (dailyDeltas && dailyDeltas.length >= MIN_DELTAS_FOR_SIGMA) {
    const threshold = Math.max(10, stdev(dailyDeltas) * (sigma ?? 3));
    return { isAnomaly: Math.abs(delta) >= threshold, delta, pct, threshold, mode: 'sigma' };
  }
  const isAnomaly = pct >= pctThreshold && Math.abs(delta) >= absMin;
  return { isAnomaly, delta, pct, threshold: absMin, mode: 'legacy' };
}

/**
 * σ計算用の日次増減系列(before 直前の30日、JST日ごとの終値の隣接差分)を取得する。
 */
export async function fetchDailyDeltas(
  db: D1Database,
  accountId: number,
  before: string,
  days = 30
): Promise<number[]> {
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(beforeMs)) return [];
  const from = new Date(beforeMs - days * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT collected_at, followers FROM snapshots
       WHERE account_id = ? AND collected_at >= ? AND collected_at < ?
       ORDER BY collected_at ASC`
    )
    .bind(accountId, from, before)
    .all<{ collected_at: string; followers: number }>();

  // JST日ごとの終値(昇順入力で後勝ち)→ 隣接差分
  const byDay = new Map<string, number>();
  for (const r of results ?? []) {
    byDay.set(
      new Date(Date.parse(r.collected_at) + JST_OFFSET_MS).toISOString().slice(0, 10),
      r.followers
    );
  }
  const ends = [...byDay.values()];
  const deltas: number[] = [];
  for (let i = 1; i < ends.length; i++) deltas.push(ends[i] - ends[i - 1]);
  return deltas;
}

// ---- 投稿の急伸(post_spike)/不調(slump)----

export interface PostAlertsResult {
  eventsCreated: number;
}

/**
 * managed アカウントの投稿スナップショット書込後に呼ぶ。
 * - post_spike: posted_at から48時間以内の投稿の reach >= 直近30日投稿の reach 中央値 × post_spike_multiple(既定3)
 * - slump: 直近3投稿すべての reach < 中央値 × slump_multiple(既定0.5)
 * どちらも events を検索して同一対象への重複発報を抑止する。
 */
export async function evaluatePostAlerts(
  db: D1Database,
  account: AccountRow,
  collectedAt: string,
  settings: SettingsMap
): Promise<PostAlertsResult> {
  const collectedMs = Date.parse(collectedAt);
  if (!Number.isFinite(collectedMs)) return { eventsCreated: 0 };

  const spikeMultiple = getNumberSetting(settings, 'post_spike_multiple', 3);
  const slumpMultiple = getNumberSetting(settings, 'slump_multiple', 0.5);

  // ベースライン: 直近30日に投稿された投稿の最新 reach の中央値
  const baselineFrom = new Date(collectedMs - 30 * DAY_MS).toISOString();
  const { results: baseRows } = await db
    .prepare(
      `SELECT (SELECT ps.reach FROM post_snapshots ps
          WHERE ps.post_id = p.id AND ps.reach IS NOT NULL
          ORDER BY ps.collected_at DESC LIMIT 1) AS reach
       FROM posts p WHERE p.account_id = ? AND p.posted_at >= ?`
    )
    .bind(account.id, baselineFrom)
    .all<{ reach: number | null }>();
  const baseline = median(
    (baseRows ?? []).map((r) => r.reach).filter((v): v is number => v !== null)
  );
  if (baseline === null || baseline <= 0) return { eventsCreated: 0 }; // データ不足時は判定しない

  let eventsCreated = 0;

  // ---- 急伸: posted_at が48時間以内の投稿 ----
  const spikeFrom = new Date(collectedMs - 48 * HOUR_MS).toISOString();
  const { results: recentRows } = await db
    .prepare(
      `SELECT p.external_id,
         (SELECT ps.reach FROM post_snapshots ps
           WHERE ps.post_id = p.id AND ps.reach IS NOT NULL
           ORDER BY ps.collected_at DESC LIMIT 1) AS reach
       FROM posts p WHERE p.account_id = ? AND p.posted_at >= ?`
    )
    .bind(account.id, spikeFrom)
    .all<{ external_id: string; reach: number | null }>();

  for (const r of recentRows ?? []) {
    if (r.reach === null || r.reach < baseline * spikeMultiple) continue;
    const dup = await db
      .prepare(
        `SELECT id FROM events WHERE type = 'post_spike' AND account_id = ?
           AND json_extract(payload_json, '$.external_id') = ? LIMIT 1`
      )
      .bind(account.id, r.external_id)
      .first();
    if (dup) continue; // 同一投稿へは一度だけ
    const multiple = r.reach / baseline;
    await emitEvent(db, {
      type: 'post_spike',
      accountId: account.id,
      message: `@${account.handle} の投稿 ${r.external_id} が急伸: リーチ ${r.reach}(直近30日中央値 ${baseline} の ${multiple.toFixed(1)}倍)`,
      payload: { external_id: r.external_id, reach: r.reach, baseline_median: baseline, multiple },
    });
    eventsCreated += 1;
  }

  // ---- 不調: 直近3投稿すべての reach < 中央値 × slump_multiple ----
  const { results: last3 } = await db
    .prepare(
      `SELECT p.external_id,
         (SELECT ps.reach FROM post_snapshots ps
           WHERE ps.post_id = p.id AND ps.reach IS NOT NULL
           ORDER BY ps.collected_at DESC LIMIT 1) AS reach
       FROM posts p WHERE p.account_id = ? AND p.posted_at IS NOT NULL
       ORDER BY p.posted_at DESC LIMIT 3`
    )
    .bind(account.id)
    .all<{ external_id: string; reach: number | null }>();
  const posts3 = last3 ?? [];
  const allSlump =
    posts3.length === 3 &&
    posts3.every((p) => p.reach !== null && p.reach < baseline * slumpMultiple);
  if (allSlump) {
    // 最新投稿が変わるまでは再発報しない(latest_external_id で重複抑止)
    const latestId = posts3[0].external_id;
    const dup = await db
      .prepare(
        `SELECT id FROM events WHERE type = 'slump' AND account_id = ?
           AND json_extract(payload_json, '$.latest_external_id') = ? LIMIT 1`
      )
      .bind(account.id, latestId)
      .first();
    if (!dup) {
      await emitEvent(db, {
        type: 'slump',
        accountId: account.id,
        message: `@${account.handle} 直近3投稿のリーチがいずれも直近30日中央値 ${baseline} の ${slumpMultiple}倍未満です`,
        payload: {
          latest_external_id: latestId,
          posts: posts3.map((p) => ({ external_id: p.external_id, reach: p.reach })),
          baseline_median: baseline,
          slump_multiple: slumpMultiple,
        },
      });
      eventsCreated += 1;
    }
  }

  return { eventsCreated };
}
