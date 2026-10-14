import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { getSettingsMap } from '../lib/settings';

const settings = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: GET /settings は Bearer INGEST_SECRET(collector 用)
settings.use('*', requireBearer('INGEST_SECRET'));

settings.get('/', async (c) => {
  const map = await getSettingsMap(c.env.DB);
  return c.json({ settings: map });
});

export default settings;
