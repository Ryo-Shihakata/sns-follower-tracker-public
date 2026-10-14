import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { getEvents } from '../lib/queries';

const events = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: GET /api/events は Bearer READ_API_TOKEN(外部ダッシュボード用)
events.use('*', requireBearer('READ_API_TOKEN'));

events.get('/', async (c) => {
  const since = c.req.query('since') ?? null;
  const type = c.req.query('type') ?? null;
  const limitParam = Number(c.req.query('limit') ?? '200');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;

  const data = await getEvents(c.env.DB, { since, type, limit });
  return c.json({ events: data });
});

export default events;
