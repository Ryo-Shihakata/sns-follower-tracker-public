import { Hono } from 'hono';
import type { Env } from '../types';
import { listAccounts } from '../lib/accounts';
import { getEvents } from '../lib/queries';
import { renderDashboardHtml } from '../lib/dashboardHtml';

const dashboard = new Hono<{ Bindings: Env }>();

const DEFAULT_HANDLE = 'example_account';

dashboard.get('/', async (c) => {
  const db = c.env.DB;
  const accounts = await listAccounts(db); // 全件(設定パネルは非activeも表示・再有効化できる必要がある)
  const events = await getEvents(db, { limit: 200 });

  // 既定は example_account(なければ先頭の active、それも無ければ先頭)。
  const active = accounts.filter((a) => a.active === 1);
  const fj = active.find((a) => a.handle === DEFAULT_HANDLE);
  const defaultAccountId = fj?.id ?? active[0]?.id ?? accounts[0]?.id ?? 0;

  const html = renderDashboardHtml({ accounts, events, defaultAccountId });
  return c.html(html);
});

export default dashboard;
