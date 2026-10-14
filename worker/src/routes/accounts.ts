import { Hono } from 'hono';
import type { Env } from '../types';
import { requireBearer } from '../lib/auth';
import { listAccounts, createAccount, updateAccount, type AccountPatch } from '../lib/accounts';

const accounts = new Hono<{ Bindings: Env }>();

// 計画書 §5.5: GET/POST /accounts, PATCH /accounts/:id はすべて Bearer INGEST_SECRET
accounts.use('*', requireBearer('INGEST_SECRET'));

// active なアカウント一覧(collector 用)
accounts.get('/', async (c) => {
  const rows = await listAccounts(c.env.DB, { activeOnly: true });
  return c.json({ accounts: rows });
});

accounts.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.platform_id !== 'string' ||
    typeof body.handle !== 'string' ||
    !body.handle.trim()
  ) {
    return c.json({ error: 'platform_id and handle are required' }, 400);
  }

  const platform = await c.env.DB
    .prepare(`SELECT id FROM platforms WHERE id = ?`)
    .bind(body.platform_id)
    .first();
  if (!platform) {
    return c.json({ error: `unknown platform_id: ${body.platform_id}` }, 400);
  }

  try {
    const id = await createAccount(c.env.DB, {
      platform_id: body.platform_id,
      handle: body.handle,
      display_name: body.display_name ?? null,
      active: body.active,
      managed: body.managed,
    });
    return c.json({ id }, 201);
  } catch (err) {
    // UNIQUE(platform_id, handle) 違反
    return c.json({ error: 'account already exists for this platform_id + handle' }, 409);
  }
});

accounts.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const patch: AccountPatch = {};
  if ('active' in body) patch.active = Boolean(body.active);
  if ('managed' in body) patch.managed = Boolean(body.managed);
  if ('display_name' in body) patch.display_name = body.display_name;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'no updatable fields provided (active/managed/display_name)' }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (!before) return c.json({ error: 'account not found' }, 404);

  const updated = await updateAccount(c.env.DB, id, patch);
  return c.json({ account: updated });
});

export default accounts;
