import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { getPostsWithLatest, getPostSeries } from '../lib/queries';

const posts = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: GET /api/posts, /api/posts/:post_id/series は Bearer READ_API_TOKEN
posts.use('*', requireBearer('READ_API_TOKEN'));

posts.get('/', async (c) => {
  const accountIdParam = c.req.query('account_id');
  if (!accountIdParam) return c.json({ error: 'account_id is required' }, 400);
  const accountId = Number(accountIdParam);
  if (!Number.isInteger(accountId)) return c.json({ error: 'invalid account_id' }, 400);

  const limitParam = Number(c.req.query('limit') ?? '20');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;

  const data = await getPostsWithLatest(c.env.DB, accountId, limit);
  return c.json({ posts: data });
});

posts.get('/:post_id/series', async (c) => {
  const postId = Number(c.req.param('post_id'));
  if (!Number.isInteger(postId)) return c.json({ error: 'invalid post_id' }, 400);

  const data = await getPostSeries(c.env.DB, postId);
  return c.json({ series: data });
});

export default posts;
