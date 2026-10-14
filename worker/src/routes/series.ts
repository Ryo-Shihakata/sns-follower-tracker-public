import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { cacheResponse } from '../lib/cache';
import { getSeriesForAccounts } from '../lib/queries';
import { aggregateToBucketEnds, normalizeBucket } from '../lib/analytics';

const series = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: GET /api/series は Bearer READ_API_TOKEN(外部ダッシュボード用)
series.use('*', requireBearer('READ_API_TOKEN'));
// Workers Cache(計画書 §5.5)。認証通過後に適用。
series.use('*', cacheResponse(300));

// account_id はカンマ区切りで複数指定可(拡張: グラフの重ね描き用)
// bucket=day|week|month(既定 day)。集約は各バケットの終値(計画書 §3)。
series.get('/', async (c) => {
  const accountIdParam = c.req.query('account_id');
  if (!accountIdParam) return c.json({ error: 'account_id is required' }, 400);

  const accountIds = accountIdParam
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  if (accountIds.length === 0) return c.json({ error: 'invalid account_id' }, 400);

  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const bucket = normalizeBucket(c.req.query('bucket'));

  const data = await getSeriesForAccounts(c.env.DB, accountIds, from, to);
  // day 以外は各アカウントの points をバケット終値へ集約。従来形(bucket 無し=day)は非集約と
  // 同義になるよう、day のときは既存の生データ(同日複数点も保持)をそのまま返す。
  const shaped =
    bucket === 'day'
      ? data
      : data.map((s) => ({ ...s, points: aggregateToBucketEnds(s.points, bucket) }));

  return c.json({ series: shaped, bucket });
});

export default series;
