import { Hono } from 'hono';
import type { Env } from '../types';
import { listAccounts } from '../lib/accounts';
import { renderMonitorHtml, toMonitorAccounts } from '../lib/monitorHtml';

/**
 * モニターモード HTML(計画書 §2.2)。GET /monitor。
 * ダッシュボード本体と同じく Cloudflare Access 配下・同一オリジンの /ui/monitor から
 * 数値を取得する(Bearer 非要求)。?account_id= 既定は example_account、?rotate=1 で巡回。
 */
const monitor = new Hono<{ Bindings: Env }>();

const DEFAULT_HANDLE = 'example_account';

monitor.get('/', async (c) => {
  const accounts = await listAccounts(c.env.DB, { activeOnly: true });
  if (accounts.length === 0) {
    return c.html('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">アクティブなアカウントがありません。</body>');
  }

  const requested = c.req.query('account_id');
  let defaultAccountId: number | null = null;
  if (requested) {
    const n = Number(requested);
    if (Number.isInteger(n) && accounts.some((a) => a.id === n)) defaultAccountId = n;
  }
  if (defaultAccountId === null) {
    const fj = accounts.find((a) => a.handle === DEFAULT_HANDLE);
    defaultAccountId = fj ? fj.id : accounts[0].id;
  }

  const rotate = c.req.query('rotate') === '1';
  const refreshParam = Number(c.req.query('refresh') ?? '300');
  const refreshSeconds = Number.isFinite(refreshParam) && refreshParam >= 30 ? refreshParam : 300;

  const html = renderMonitorHtml({
    accounts: toMonitorAccounts(accounts),
    defaultAccountId,
    rotate,
    refreshSeconds,
  });
  return c.html(html);
});

export default monitor;
