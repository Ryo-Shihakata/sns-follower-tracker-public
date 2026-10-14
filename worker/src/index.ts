import { Hono } from 'hono';
import type { Env } from './types';
import ingest from './routes/ingest';
import accounts from './routes/accounts';
import settingsRoute from './routes/settings';
import series from './routes/series';
import posts from './routes/posts';
import events from './routes/events';
import dashboard from './routes/dashboard';
import ui from './routes/ui';
import insights from './routes/insights';
import monitor from './routes/monitor';
import img from './routes/img';
import reportsRoute, { reportsUiMirror } from './routes/reports';
import { runFreshnessCheck, runReportGeneration, REPORT_CRON } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.route('/', dashboard);
app.route('/monitor', monitor);
app.route('/ui', ui);
// レポートの同一オリジンミラー(/ui/reports*)。routes/ui.ts は別実装なので追加マウントで足す
app.route('/ui', reportsUiMirror);
app.route('/img', img);

app.route('/ingest', ingest);
app.route('/accounts', accounts);
app.route('/settings', settingsRoute);

app.route('/api/series', series);
app.route('/api/posts', posts);
app.route('/api/events', events);

// レポート API(insights の use('*') より先に登録し、こちらの認証設定を使う)
app.route('/api/reports', reportsRoute);
// v3 追加読取 API(/api/summary, /api/followers/diff, /api/likes/series, /api/monitor)
app.route('/api', insights);

export default {
  fetch: app.fetch,
  // Cron Trigger は2本(wrangler.jsonc の triggers.crons):
  // - 鮮度点検(計画書 §5.7)
  // - レポート生成(docs/insights-reports-plan.md §4、JST 7:00 = 22:00 UTC)
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === REPORT_CRON) {
      ctx.waitUntil(runReportGeneration(env));
    } else {
      ctx.waitUntil(runFreshnessCheck(env));
    }
  },
};
