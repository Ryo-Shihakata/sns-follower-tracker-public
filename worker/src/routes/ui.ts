import { Hono } from 'hono';
import type { Env } from '../types';
import { createAccount, updateAccount, deleteAccount, type AccountPatch } from '../lib/accounts';
import { getPostsWithLatest, getPostSeries, setEventAcknowledged } from '../lib/queries';
import {
  getSummary,
  getFollowersDiff,
  getLikesSeries,
  getMonitor,
  getOverview,
  getAudienceStats,
  normalizeBucket,
} from '../lib/analytics';
import { renderReportHtml } from '../lib/reportHtml';
import { getSettingsMap } from '../lib/settings';
import { isAuthed, handleLogin, requireSettingsAuth } from '../lib/uiAuth';

/**
 * ダッシュボード(同一オリジン)専用の内部エンドポイント。
 *
 * 設計判断: 計画書 §5.5 は "UI→自API呼び出しは同一オリジンのセッションで許可
 * (実装時は Access JWT 検証 or UI 専用パス)" としており、本実装は後者
 * (UI 専用パス)を採用した。本番では Cloudflare Access がこのパス自体を含む
 * ダッシュボード全体を保護する前提のため、ここでは Bearer 認証を要求しない
 * (INGEST_SECRET / READ_API_TOKEN をブラウザに渡さずに済む)。
 * ローカル wrangler dev では Access がないため実質無防備だが、本タスクは
 * ローカル検証のみが対象のため許容している。
 */
const ui = new Hono<{ Bindings: Env }>();

// レポートページ(insights-reports-plan §5)。静的シェルを返し、データは同一オリジンの
// /api/reports 系(バックエンドは別実装)からクライアント側で取得する。D1 には触れない。
ui.get('/report', (c) => c.html(renderReportHtml()));

ui.get('/posts', async (c) => {
  const accountIdParam = c.req.query('account_id');
  if (!accountIdParam) return c.json({ error: 'account_id is required' }, 400);
  const accountId = Number(accountIdParam);
  if (!Number.isInteger(accountId)) return c.json({ error: 'invalid account_id' }, 400);
  const limit = Number(c.req.query('limit') ?? '20') || 20;
  const data = await getPostsWithLatest(c.env.DB, accountId, limit);
  return c.json({ posts: data });
});

ui.get('/posts/:post_id/series', async (c) => {
  const postId = Number(c.req.param('post_id'));
  if (!Number.isInteger(postId)) return c.json({ error: 'invalid post_id' }, 400);
  const data = await getPostSeries(c.env.DB, postId);
  return c.json({ series: data });
});

// ---- ダッシュボード v3 の同一オリジン読取(トークン非埋込。/api/* と同じ計算を共有)----

function uiAccountId(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

ui.get('/summary', async (c) => {
  const accountId = uiAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const data = await getSummary(c.env.DB, accountId, from, to);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ summary: data });
});

ui.get('/followers/diff', async (c) => {
  const accountId = uiAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const bucket = normalizeBucket(c.req.query('bucket'));
  const data = await getFollowersDiff(c.env.DB, accountId, from, to, bucket);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ diff: data });
});

ui.get('/likes/series', async (c) => {
  const accountId = uiAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const limitParam = Number(c.req.query('limit') ?? '6');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 12) : 6;
  const data = await getLikesSeries(c.env.DB, accountId, limit);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ likes: data });
});

ui.get('/monitor', async (c) => {
  const accountId = uiAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const data = await getMonitor(c.env.DB, accountId);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ monitor: data });
});

// 概要の「全アカウント」表示用。active な全アカウントの増減サマリー。
ui.get('/overview', async (c) => {
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const items = await getOverview(c.env.DB, from, to);
  return c.json({ overview: items });
});

ui.get('/audience', async (c) => {
  const accountId = uiAccountId(c.req.query('account_id'));
  if (accountId === null) return c.json({ error: 'account_id is required' }, 400);
  const data = await getAudienceStats(c.env.DB, accountId);
  if (!data) return c.json({ error: 'account not found' }, 404);
  return c.json({ audience: data });
});

// v11: 設定ビューの権限管理(docs/settings-auth.md)。SETTINGS_PASSWORD 未設定なら開放。
ui.get('/auth/status', async (c) => c.json(await isAuthed(c)));
ui.post('/auth/login', handleLogin);

// v9 Phase B-3: フォロワー目標(settings.follower_goal)の読み書き。/ui はダッシュボードの
// 設定ビューから直接叩く同一オリジン専用パス(既存 /ui/accounts 等と同じ流儀)。
const APP_SETTINGS_ALLOWLIST = new Set(['follower_goal']);

ui.get('/app-settings', async (c) => {
  const map = await getSettingsMap(c.env.DB);
  return c.json({ settings: map });
});

ui.put('/app-settings', requireSettingsAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.key !== 'string' || typeof body.value !== 'string') {
    return c.json({ error: 'key and value (string) are required' }, 400);
  }
  if (!APP_SETTINGS_ALLOWLIST.has(body.key)) {
    return c.json({ error: `key not allowed: ${body.key}` }, 400);
  }
  if (body.value === '') {
    await c.env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(body.key).run();
  } else {
    await c.env.DB
      .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
      .bind(body.key, body.value)
      .run();
  }
  return c.json({ ok: true });
});

ui.post('/accounts', requireSettingsAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.platform_id !== 'string' || typeof body.handle !== 'string' || !body.handle.trim()) {
    return c.json({ error: 'platform_id and handle are required' }, 400);
  }
  const platform = await c.env.DB
    .prepare(`SELECT id FROM platforms WHERE id = ?`)
    .bind(body.platform_id)
    .first();
  if (!platform) return c.json({ error: `unknown platform_id: ${body.platform_id}` }, 400);

  try {
    const id = await createAccount(c.env.DB, {
      platform_id: body.platform_id,
      handle: body.handle,
      display_name: body.display_name ?? null,
      active: body.active,
      managed: body.managed,
    });
    return c.json({ id }, 201);
  } catch {
    return c.json({ error: 'account already exists for this platform_id + handle' }, 409);
  }
});

ui.patch('/accounts/:id', requireSettingsAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const patch: AccountPatch = {};
  if ('active' in body) patch.active = Boolean(body.active);
  if ('managed' in body) patch.managed = Boolean(body.managed);
  if ('display_name' in body) patch.display_name = body.display_name;
  if ('handle' in body) {
    if (typeof body.handle !== 'string' || !body.handle.trim()) {
      return c.json({ error: 'handle must be a non-empty string' }, 400);
    }
    patch.handle = body.handle.trim();
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'no updatable fields provided' }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (!before) return c.json({ error: 'account not found' }, 404);

  try {
    const updated = await updateAccount(c.env.DB, id, patch);
    return c.json({ account: updated });
  } catch {
    // handle 変更で UNIQUE(platform_id, handle) 衝突
    return c.json({ error: 'handle already exists for this platform' }, 409);
  }
});

ui.delete('/accounts/:id', requireSettingsAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const ok = await deleteAccount(c.env.DB, id);
  if (!ok) return c.json({ error: 'account not found' }, 404);
  return c.json({ ok: true });
});

ui.patch('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.acknowledged !== 'boolean') {
    return c.json({ error: 'acknowledged (boolean) is required' }, 400);
  }
  const changed = await setEventAcknowledged(c.env.DB, id, body.acknowledged);
  if (!changed) return c.json({ error: 'event not found' }, 404);
  return c.json({ ok: true });
});

export default ui;
