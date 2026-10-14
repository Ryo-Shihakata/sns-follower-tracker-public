import type { Env } from './types';
import { listAccounts } from './lib/accounts';
import { getSettingsMap, getNumberSetting } from './lib/settings';
import { emitEvent } from './lib/events';
import { classifyThemes } from './lib/themes';
import { notifyTeamsReports } from './lib/teams';
import {
  previousPeriod,
  generateReportsForPeriod,
  type GenerateResult,
  type ReportKind,
} from './lib/reports';

/** レポート生成 cron(= JST 7:00)。wrangler.jsonc の triggers.crons と一致させること。 */
export const REPORT_CRON = '0 22 * * *';

/**
 * docs/insights-reports-plan.md §4: 毎朝 JST 7:00 に前日分の日報を生成する。
 * JST で月曜なら前週分の週報、JST で1日なら前月分の月報も併せて生成する。
 * LLM 失敗時も metrics のみで保存される(lib/reports.ts 側で吸収)。
 */
export async function runReportGeneration(env: Env, now: Date = new Date()): Promise<GenerateResult[]> {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kinds: ReportKind[] = ['daily'];
  if (jst.getUTCDay() === 1) kinds.push('weekly');
  if (jst.getUTCDate() === 1) kinds.push('monthly');

  // v9 Phase B-2: レポート生成前に managed アカウントごとテーマ分類を試みる。
  // 失敗してもレポート生成自体は続行する(翌日以降の cron で再試行される設計)。
  const managed = (await listAccounts(env.DB, { activeOnly: true })).filter((a) => a.managed === 1);
  for (const account of managed) {
    try {
      await classifyThemes(env, env.DB, account.id);
    } catch (e) {
      console.error(`theme classification failed (account=${account.handle}):`, e);
    }
  }

  const results: GenerateResult[] = [];
  for (const kind of kinds) {
    const period = previousPeriod(kind, now);
    results.push(await generateReportsForPeriod(env, period));
    // v10: Power Automate 経由の Teams 通知(TEAMS_WEBHOOK_URL 未設定ならスキップ)。
    // 通知失敗でレポート生成 cron を落とさない。
    try {
      await notifyTeamsReports(env, kind, period.start);
    } catch (e) {
      console.error(`teams notify failed (${kind} ${period.start}):`, e);
    }
  }
  return results;
}

/**
 * 計画書 §5.7: 鮮度点検。active アカウントごとに最新の run を確認し、
 * freshness_hours(settings)を超過していれば events(type='stale') を記録する。
 * 同じ run が原因で毎日重複発火しないよう、直近の run 以降にすでに
 * stale イベントがあれば再送しない。
 */
export interface FreshnessResult {
  checked: number;
  staleEmitted: number;
}

export async function runFreshnessCheck(env: Env): Promise<FreshnessResult> {
  const db = env.DB;
  const accounts = await listAccounts(db, { activeOnly: true });
  const settingsMap = await getSettingsMap(db);
  const freshnessHours = getNumberSetting(settingsMap, 'freshness_hours', 30);

  const now = Date.now();
  let staleEmitted = 0;

  for (const account of accounts) {
    const latestRun = await db
      .prepare(`SELECT ran_at FROM collection_runs WHERE account_id = ? ORDER BY ran_at DESC LIMIT 1`)
      .bind(account.id)
      .first<{ ran_at: string }>();

    // 一度も収集run記録がないアカウントは対象外(既知の制限。レポート参照)
    if (!latestRun) continue;

    const ranAtMs = Date.parse(latestRun.ran_at);
    if (!Number.isFinite(ranAtMs)) continue;

    const hoursSince = (now - ranAtMs) / (1000 * 60 * 60);
    if (hoursSince <= freshnessHours) continue;

    const existingStale = await db
      .prepare(
        `SELECT id FROM events WHERE account_id = ? AND type = 'stale' AND created_at > ? LIMIT 1`
      )
      .bind(account.id, latestRun.ran_at)
      .first();
    if (existingStale) continue; // すでにこのrun以降で通知済み

    await emitEvent(db, {
      type: 'stale',
      accountId: account.id,
      message: `@${account.handle} が ${hoursSince.toFixed(1)}時間 収集されていません(閾値 ${freshnessHours}時間)`,
      payload: {
        hours_since: hoursSince,
        freshness_hours: freshnessHours,
        last_ran_at: latestRun.ran_at,
      },
    });
    staleEmitted += 1;
  }

  return { checked: accounts.length, staleEmitted };
}
