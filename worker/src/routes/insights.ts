import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { cacheResponse } from '../lib/cache';
import {
  getSummary,
  getFollowersDiff,
  getLikesSeries,
  getMonitor,
  getOverview,
  getDailyExport,
  getAudienceStats,
  normalizeBucket,
} from '../lib/analytics';

/**
 * ダッシュボード v3 の読取 API 群(計画書 §3)。すべて Bearer READ_API_TOKEN。
 * /api 配下に summary / followers/diff / likes/series / monitor を追加する。
 * (既存 /api/series・/api/posts・/api/events とはパスが衝突しない)
 *
 * トークンを埋め込まない同一オリジン UI 版は routes/ui.ts 側に用意する。
 */
const insights = new Hono<{ Bindings: Env }>();

insights.use('*', requireBearer('READ_API_TOKEN'));
// Workers Cache(計画書 §5.5)。収集は毎時なので 300s で十分新鮮。認証通過後に適用。
insights.use('*', cacheResponse(300));

function parseAccountId(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

insights.get('/summary', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const data = await getSummary(c.env.DB, accountId, from, to);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ summary: data });
});

insights.get('/followers/diff', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const bucket = normalizeBucket(c.req.query('bucket'));
  const data = await getFollowersDiff(c.env.DB, accountId, from, to, bucket);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ diff: data });
});

insights.get('/likes/series', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const limitParam = Number(c.req.query('limit') ?? '6');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 12) : 6;
  const data = await getLikesSeries(c.env.DB, accountId, limit);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ likes: data });
});

insights.get('/monitor', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const data = await getMonitor(c.env.DB, accountId);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ monitor: data });
});

insights.get('/overview', async (c) => {
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const items = await getOverview(c.env.DB, from, to);
  return c.json({ overview: items });
});

insights.get('/audience', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const data = await getAudienceStats(c.env.DB, accountId);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ audience: data });
});

// GAS スプレッドシート連携用の日次エクスポート(docs/gas-spreadsheet.md)。
// ?format=csv で CSV、既定は JSON({columns, rows})。
insights.get('/export/daily', async (c) => {
  const accountId = parseAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const data = await getDailyExport(c.env.DB, accountId, from, to);
  if (c.req.query('format') === 'csv') {
    const esc = (v: string | number | null) => {
      if (v === null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [data.columns.join(','), ...data.rows.map((r) => r.map(esc).join(','))];
    return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
  }
  return c.json(data);
});

export default insights;
