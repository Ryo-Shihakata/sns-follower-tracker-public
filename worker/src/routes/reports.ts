import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { cacheResponse, purgeCache } from '../lib/cache';
import {
  isReportKind,
  listReports,
  getReport,
  periodFromStart,
  generateReportsForPeriod,
  jstTodayString,
} from '../lib/reports';

/**
 * レポート API(docs/insights-reports-plan.md §4)。
 * - /api/reports/*: 外部用。読取は Bearer READ_API_TOKEN、regenerate は書込系なので INGEST_SECRET。
 * - /ui/reports/*(reportsUiMirror): ダッシュボード同一オリジン用のトークン非埋込ミラー
 *   (routes/ui.ts の /ui/summary 等と同じ方式。本番は Cloudflare Access が保護する前提)。
 *
 * キャッシュ(§5.5): /api 側のみ。一覧=300s、本文は過去期間=86400s / 当日を含む期間=300s。
 * regenerate 時に該当 URL を明示パージする。/ui/* には適用しない。
 */

type ReportContext = Context<{ Bindings: Env }>;

/** 過去期間のレポートは実質不変なので長TTL、当日を含む期間だけ短TTL。 */
function reportDetailTtl(c: ReportContext): number {
  const kind = c.req.param('kind');
  if (!isReportKind(kind)) return 300;
  const period = periodFromStart(kind, c.req.param('period_start') ?? '');
  if (!period) return 300;
  return period.end < jstTodayString() ? 86400 : 300;
}

// ---- /api と /ui ミラーで共有するハンドラ ----

// 一覧(メタのみ。metrics/llm 本文は含めない)
async function handleList(c: ReportContext) {
  const kindParam = c.req.query('kind') ?? null;
  if (kindParam !== null && !isReportKind(kindParam)) {
    return c.json({ error: 'kind must be daily|weekly|monthly' }, 400);
  }
  const limitParam = Number(c.req.query('limit') ?? '30');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 30;
  const items = await listReports(c.env.DB, { kind: kindParam, limit });
  return c.json({ reports: items });
}

// 本文。account_id 省略時は最小 account_id(現状 managed は1アカウント)。
async function handleDetail(c: ReportContext) {
  const kind = c.req.param('kind');
  if (!isReportKind(kind)) return c.json({ error: 'kind must be daily|weekly|monthly' }, 400);
  const periodStart = c.req.param('period_start') ?? '';

  let accountId: number | null = null;
  const accountIdParam = c.req.query('account_id');
  if (accountIdParam !== undefined) {
    const n = Number(accountIdParam);
    if (!Number.isInteger(n)) return c.json({ error: 'invalid account_id' }, 400);
    accountId = n;
  }

  const report = await getReport(c.env.DB, kind, periodStart, accountId);
  if (!report) return c.json({ error: 'report not found' }, 404);
  return c.json({ report });
}

// ---- /api/reports(Bearer 認証 + Workers Cache)----

const reports = new Hono<{ Bindings: Env }>();

reports.get('/', requireBearer('READ_API_TOKEN'), cacheResponse(300), handleList);
reports.get(
  '/:kind/:period_start',
  requireBearer('READ_API_TOKEN'),
  cacheResponse(reportDetailTtl),
  handleDetail
);

// 再集計 + LLM 再生成(管理操作。書込系なので INGEST_SECRET)
reports.post('/:kind/:period_start/regenerate', requireBearer('INGEST_SECRET'), async (c) => {
  const kind = c.req.param('kind');
  if (!isReportKind(kind)) return c.json({ error: 'kind must be daily|weekly|monthly' }, 400);
  const period = periodFromStart(kind, c.req.param('period_start') ?? '');
  if (!period) return c.json({ error: 'invalid period_start (YYYY-MM-DD)' }, 400);

  const result = await generateReportsForPeriod(c.env, period);

  // 該当 URL のキャッシュを明示パージする。detail は account_id 無し(既定=最小id)と
  // 生成対象アカウントごとの account_id 付きバリアント、list は素の URL と
  // アプリ/クライアントが使う ?kind=&limit=30 バリアントを消す。
  const origin = new URL(c.req.url).origin;
  const detail = `${origin}/api/reports/${kind}/${period.start}`;
  await purgeCache(detail);
  for (const id of result.account_ids) {
    await purgeCache(`${detail}?account_id=${id}`);
  }
  await purgeCache(`${origin}/api/reports`);
  await purgeCache(`${origin}/api/reports?kind=${kind}&limit=30`);

  return c.json({ ok: true, ...result });
});

// ---- /ui ミラー(トークン非埋込。index.ts で app.route('/ui', reportsUiMirror))----

export const reportsUiMirror = new Hono<{ Bindings: Env }>();

reportsUiMirror.get('/reports', handleList);
reportsUiMirror.get('/reports/:kind/:period_start', handleDetail);

export default reports;
