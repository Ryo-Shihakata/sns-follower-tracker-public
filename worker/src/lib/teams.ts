/**
 * v10: Microsoft Power Automate 経由の Teams 通知。
 * 「HTTP 要求の受信時」トリガーのフロー URL(secret: TEAMS_WEBHOOK_URL)へ、
 * cron で生成したレポートの要約 JSON を POST する。フロー側で Teams チャットへ整形投稿する。
 *
 * - TEAMS_WEBHOOK_URL 未設定なら何もしない(オプトイン機能)
 * - 送信失敗はイベント記録のみで、cron のレポート生成は落とさない(呼び出し側で catch)
 */
import type { Env } from '../types';
import { emitEvent } from './events';
import type { ReportKind } from './reports';

/** フローが受け取るペイロード(docs/teams-notification.md にスキーマを記載)。 */
interface TeamsReportPayload {
  kind: ReportKind;
  period_start: string;
  period_end: string;
  handle: string;
  followers: number | null;
  followers_delta: number | null;
  summary: string;
  factors: string[];
  actions: string[];
  report_url: string;
}

interface ReportNotifyRow {
  period_end: string;
  handle: string;
  account_id: number;
  metrics_json: string;
  llm_json: string | null;
}

export async function notifyTeamsReports(env: Env, kind: ReportKind, periodStart: string): Promise<void> {
  const url = env.TEAMS_WEBHOOK_URL;
  if (!url) return;

  const { results } = await env.DB.prepare(
    `SELECT r.period_end, r.account_id, r.metrics_json, r.llm_json, a.handle
     FROM reports r JOIN accounts a ON a.id = r.account_id
     WHERE r.kind = ? AND r.period_start = ?`
  )
    .bind(kind, periodStart)
    .all<ReportNotifyRow>();

  for (const row of results ?? []) {
    let payload: TeamsReportPayload;
    try {
      const metrics = JSON.parse(row.metrics_json) as {
        kpi?: { followers?: number | null; delta?: number | null };
      };
      const llm = row.llm_json
        ? (JSON.parse(row.llm_json) as { summary?: string; factors?: string[]; actions?: string[] })
        : null;
      const base = env.REPORT_BASE_URL ?? '';
      payload = {
        kind,
        period_start: periodStart,
        period_end: row.period_end,
        handle: row.handle,
        followers: metrics.kpi?.followers ?? null,
        followers_delta: metrics.kpi?.delta ?? null,
        summary: llm?.summary ?? '',
        factors: llm?.factors ?? [],
        actions: llm?.actions ?? [],
        report_url: base ? `${base}/ui/report?kind=${kind}&period=${periodStart}` : '',
      };
    } catch (e) {
      console.error(`teams notify: payload build failed (${row.handle}):`, e);
      continue;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`teams notify failed (${row.handle}, ${kind} ${periodStart}):`, e);
      await emitEvent(env.DB, {
        type: 'notify_fail',
        accountId: row.account_id,
        message: `Teams通知失敗: ${detail}`,
      });
    }
  }
}
