import type { AccountRow } from './accounts';
import type { EventRow } from './queries';
import { KUMO_TOKENS, KUMO_BASE, headMeta, SW_REGISTER, logoImg, icon } from './theme';

export interface DashboardData {
  accounts: AccountRow[];
  events: EventRow[];
  defaultAccountId: number;
}

/** レポート導線アイコン(theme.ts の icon() には無いため本ファイル内に持つ。reportHtml.ts の PRINT_ICON と同じ流儀)。 */
const REPORT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M15 3v5h5"/><path d="M8.5 12h7M8.5 15.5h7M8.5 9h3"/></svg>`;

/**
 * SCTracker ダッシュボード(v4)。Kumo デザイン言語 + Noto Sans JP + PWA。
 *
 *   概要        : アカウント別(KPI×4 + フォロワー面 + いいね多系列 + 増減バー)/
 *                 「全アカウント」選択時は全アカウントの増減サマリー一覧 + 期間純増の比較
 *   投稿別分析  : サムネイル(/img プロキシ)+ 全文キャプション + 指標。managed は reach/saved も
 *   オーディエンス: Graph API 連携後に有効化するプレースホルダ
 *   設定        : アカウント管理(handle/display_name/active/managed の編集 + 追加 + 削除)
 *   イベント    : 異常イベント一覧
 *
 * データは同一オリジン /ui/*(トークン非埋込)から取得。チャートは手書き SVG(dataviz 準拠)。
 */
export function renderDashboardHtml(data: DashboardData): string {
  const embedded = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ja">
<head>
${headMeta('SCTracker')}
<style>
${KUMO_TOKENS}
${KUMO_BASE}
${CSS}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">${logoImg(26)}<span class="brand-name">SCTracker</span></div>
    <nav id="nav">
      <button class="nav-item active" data-view="overview">${icon('overview')}<span>概要</span></button>
      <button class="nav-item" data-view="posts">${icon('posts')}<span>投稿別分析</span></button>
      <button class="nav-item" data-view="audience">${icon('audience')}<span>オーディエンス</span></button>
      <button class="nav-item" data-view="settings">${icon('settings')}<span>設定</span></button>
      <button class="nav-item" data-view="events">${icon('events')}<span>イベント</span></button>
      <a class="nav-item" href="/ui/report" target="_blank" rel="noreferrer">${REPORT_ICON}<span>レポート</span></a>
    </nav>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topbar-controls">
        <label class="ctl">アカウント
          <select id="account-select"></select>
        </label>
        <label class="ctl">期間
          <select id="period-select">
            <option value="7">直近7日</option>
            <option value="30" selected>直近30日</option>
            <option value="90">直近90日</option>
            <option value="9999">全期間</option>
          </select>
        </label>
      </div>
      <a class="btn btn-ghost" id="monitor-link" href="/monitor" target="_blank" rel="noreferrer">${icon('monitor', 16)}<span>モニターモード</span></a>
    </header>

    <!-- 概要 -->
    <section class="view" id="view-overview">
      <!-- 単一アカウント -->
      <div id="overview-single">
        <div class="kpi-grid" id="kpi-grid"></div>
        <div class="chart-row">
          <section class="card chart-card">
            <div class="card-head">
              <h2>フォロワー推移</h2>
              <div class="seg" id="bucket-seg">
                <button data-bucket="day" class="active">日次</button>
                <button data-bucket="week">週次</button>
                <button data-bucket="month">月次</button>
              </div>
            </div>
            <div class="chart-host" id="chart-followers"></div>
          </section>
          <section class="card chart-card">
            <div class="card-head">
              <h2>いいね数の推移</h2>
              <span class="hint">最新投稿群のいいね時系列</span>
            </div>
            <div class="legend" id="likes-legend"></div>
            <div class="chart-host" id="chart-likes"></div>
          </section>
        </div>
        <section class="card chart-card">
          <div class="card-head">
            <h2>フォロワー増減数の推移</h2>
            <span class="legend-inline"><i class="sw sw-up"></i>増 <i class="sw sw-down"></i>減</span>
          </div>
          <div class="chart-host" id="chart-diff"></div>
        </section>
      </div>

      <!-- 全アカウント -->
      <div id="overview-all" class="hidden">
        <div class="card-head all-head"><h2>全アカウントの増減</h2><span class="hint" id="all-hint"></span></div>
        <div class="account-grid" id="account-grid"></div>
        <section class="card chart-card">
          <div class="card-head"><h2>アカウント別 期間純増</h2><span class="legend-inline"><i class="sw sw-up"></i>増 <i class="sw sw-down"></i>減</span></div>
          <div class="chart-host" id="chart-accounts-net"></div>
        </section>
      </div>
    </section>

    <!-- 投稿別分析 -->
    <section class="view hidden" id="view-posts">
      <section class="card">
        <div class="card-head"><h2>投稿別分析</h2><span class="hint" id="posts-hint"></span></div>
        <div id="posts-list" class="posts-list"></div>
      </section>
    </section>

    <!-- オーディエンス -->
    <section class="view hidden" id="view-audience">
      <section class="card placeholder" id="audience-placeholder">
        <h2>オーディエンス(性別・年齢)</h2>
        <p class="ph-lead">性別・年齢の属性サマリーは公開データでは取得できません。</p>
        <p class="ph-sub">管理アカウント(example_account)で Instagram Graph API を連携後に有効化されます。</p>
        <div class="ph-box">Graph API 連携後に有効化</div>
      </section>
      <div id="audience-content" class="hidden">
        <p class="hint" id="audience-collected"></p>
        <div class="chart-row">
          <section class="card chart-card">
            <div class="card-head"><h2>年齢分布</h2></div>
            <div class="chart-host" id="chart-audience-age"></div>
          </section>
          <section class="card chart-card">
            <div class="card-head"><h2>性別分布</h2></div>
            <div class="chart-host" id="chart-audience-gender"></div>
          </section>
        </div>
        <section class="card">
          <div class="card-head"><h2>都市(トップ10)</h2></div>
          <div class="table-wrap"><table id="audience-city-table"></table></div>
        </section>
        <section class="card chart-card">
          <div class="card-head"><h2>アクティブな時間帯</h2></div>
          <div class="chart-host" id="chart-audience-hours"></div>
          <p class="ph-sub" id="audience-hours-note" hidden>Instagramからまだ提供されていません。</p>
        </section>
      </div>
    </section>

    <!-- 設定(アカウント管理)。v11: SETTINGS_PASSWORD 設定時はパスワードロック -->
    <section class="view hidden" id="view-settings">
      <section class="card" id="settings-lock" hidden>
        <div class="card-head"><h2>設定のロック解除</h2><span class="hint">設定の変更にはパスワードが必要です</span></div>
        <form id="settings-lock-form" class="goal-form">
          <input type="password" id="settings-password" placeholder="パスワード" autocomplete="current-password" required />
          <button type="submit" class="btn btn-primary">${icon('check', 15)}解除</button>
          <span class="hint" id="settings-lock-status"></span>
        </form>
      </section>
      <div id="settings-content">
      <section class="card">
        <div class="card-head"><h2>アカウント管理</h2><span class="hint">handle・表示名・active・managed を編集できます</span></div>
        <form id="add-account-form" class="add-account-form">
          <select name="platform_id" required>
            <option value="instagram">instagram</option>
            <option value="youtube">youtube</option>
          </select>
          <input name="handle" placeholder="handle" required />
          <input name="display_name" placeholder="表示名(任意)" />
          <label class="mini-check"><input type="checkbox" name="managed" /> managed</label>
          <button type="submit" class="btn btn-primary">${icon('plus', 15)}追加</button>
        </form>
        <div class="table-wrap">
          <table id="accounts-table"></table>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>フォロワー目標</h2><span class="hint">達成予測・レポートの目標到達日の計算に使われます</span></div>
        <form id="goal-form" class="goal-form">
          <label class="ctl">フォロワー目標(人)
            <input type="number" id="goal-input" name="goal" min="0" step="1" placeholder="例: 1000" />
          </label>
          <button type="submit" class="btn btn-primary">${icon('check', 15)}保存</button>
          <span class="hint" id="goal-status"></span>
        </form>
      </section>
      </div>
    </section>

    <!-- イベント -->
    <section class="view hidden" id="view-events">
      <section class="card">
        <div class="card-head"><h2>イベント</h2></div>
        <div id="events-list" class="events-list"></div>
      </section>
    </section>
  </main>
</div>

<div id="tooltip" class="tooltip" hidden></div>

<script>
window.__DATA__ = ${embedded};
${JS}
</script>
${SW_REGISTER}
</body>
</html>`;
}

const CSS = `
.layout { display: flex; min-height: 100vh; min-height: 100dvh; }
.sidebar {
  width: 216px; flex-shrink: 0;
  background: var(--k-base); border-right: 1px solid var(--k-line);
  padding: 1.1rem 0.7rem; position: sticky; top: 0; height: 100vh; height: 100dvh;
}
.brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 800; font-size: 1.05rem; padding: 0.1rem 0.5rem 1.1rem; letter-spacing: 0.01em; }
#nav { display: flex; flex-direction: column; gap: 0.15rem; }
.nav-item {
  display: flex; align-items: center; gap: 0.6rem;
  text-align: left; background: transparent; color: var(--k-text-subtle);
  border: none; border-radius: var(--radius); padding: 0.55rem 0.7rem; font-size: 0.9rem;
}
.nav-item svg { flex-shrink: 0; }
.nav-item:hover { background: var(--k-recessed); color: var(--k-text); }
.nav-item.active { background: var(--k-recessed); color: var(--k-text); font-weight: 700; box-shadow: inset 3px 0 0 var(--k-brand); }
.main { flex: 1; min-width: 0; padding: 1.25rem 1.5rem 3rem; max-width: 1240px; padding-bottom: calc(3rem + env(safe-area-inset-bottom)); }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.topbar-controls { display: flex; gap: 1rem; flex-wrap: wrap; }
.ctl { display: flex; flex-direction: column; font-size: 0.7rem; color: var(--k-text-subtle); gap: 0.2rem; }
#monitor-link { text-decoration: none; }
.view { display: flex; flex-direction: column; gap: 1.25rem; }
.hidden { display: none; }
#overview-single, #overview-all { display: flex; flex-direction: column; gap: 1.25rem; }
#overview-single.hidden, #overview-all.hidden { display: none; }
.all-head { margin-bottom: 0; }

/* KPI カード */
.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
.kpi { background: var(--k-base); border: 1px solid var(--k-line); border-radius: var(--radius-lg); padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; box-shadow: var(--shadow-sm); }
.kpi-label { font-size: 0.78rem; color: var(--k-text-subtle); }
.kpi-value { font-size: 1.7rem; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.kpi-value.up { color: var(--up); } .kpi-value.down { color: var(--down); } .kpi-value.net { color: var(--violet); }
.kpi-badge { font-size: 0.75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; }
.kpi-badge.up { color: var(--up); } .kpi-badge.down { color: var(--down); } .kpi-badge.muted { color: var(--k-text-subtle); }
.kpi-spark { height: 34px; margin-top: 0.1rem; }

.chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
.chart-host { width: 100%; }
.seg { display: inline-flex; border: 1px solid var(--k-line); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { background: transparent; color: var(--k-text-subtle); border: none; padding: 0.32rem 0.65rem; font-size: 0.8rem; }
.seg button.active { background: var(--k-interactive); color: #fff; }
.legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.4rem; }
.legend .lg { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.76rem; color: var(--k-text-subtle); }
.legend .lg i { width: 12px; height: 3px; border-radius: 2px; display: inline-block; }
.legend-inline { font-size: 0.78rem; color: var(--k-text-subtle); display: inline-flex; align-items: center; gap: 0.3rem; }
.legend-inline .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; margin-left: 0.4rem; }
.sw-up { background: var(--up); } .sw-down { background: var(--down); }

/* 全アカウントカード */
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1rem; }
.acc-card { background: var(--k-base); border: 1px solid var(--k-line); border-radius: var(--radius-lg); padding: 0.85rem 0.95rem; display: flex; flex-direction: column; gap: 0.35rem; box-shadow: var(--shadow-sm); cursor: pointer; }
.acc-card:hover { border-color: var(--k-line-strong); }
.acc-name { font-weight: 700; font-size: 0.92rem; display: flex; align-items: center; gap: 0.35rem; }
.acc-plat { font-size: 0.66rem; color: var(--k-text-subtle); border: 1px solid var(--k-line); border-radius: 4px; padding: 0 0.25rem; }
.acc-followers { font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.acc-deltas { display: flex; gap: 0.75rem; font-size: 0.76rem; }
.acc-deltas b { font-variant-numeric: tabular-nums; }
.acc-up { color: var(--up); } .acc-down { color: var(--down); }
.acc-spark { height: 30px; }

/* 投稿 */
.posts-list { display: grid; grid-template-columns: 1fr; gap: 0.7rem; }
.post-item { display: grid; grid-template-columns: 84px 1fr auto; gap: 0.9rem; align-items: center; border: 1px solid var(--k-line); border-radius: var(--radius); padding: 0.7rem 0.85rem; }
.post-thumb { width: 84px; height: 84px; border-radius: var(--radius-sm); object-fit: cover; background: var(--k-recessed); border: 1px solid var(--k-line); display: block; }
.post-main { min-width: 0; }
.post-cap { font-size: 0.88rem; line-height: 1.4; margin-bottom: 0.35rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.post-metrics { font-size: 0.8rem; color: var(--k-text-subtle); display: flex; flex-wrap: wrap; gap: 0.15rem 0.75rem; }
.post-metrics b { color: var(--k-text); font-variant-numeric: tabular-nums; }
.post-date { font-size: 0.73rem; color: var(--k-text-subtle); margin-top: 0.3rem; }
.post-date a { text-decoration: none; }
.post-spark { width: 130px; height: 40px; flex-shrink: 0; }

/* イベント */
.events-list { display: flex; flex-direction: column; gap: 0.6rem; }
.event-item { border: 1px solid var(--k-line); border-radius: var(--radius); padding: 0.65rem 0.85rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.event-meta { font-size: 0.76rem; color: var(--k-text-subtle); margin-top: 0.15rem; }
.event-item.acked { opacity: 0.5; }

/* アカウント管理 */
.add-account-form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
.mini-check { font-size: 0.8rem; color: var(--k-text-subtle); display: inline-flex; align-items: center; gap: 0.25rem; }
#accounts-table td .edit-input { width: 100%; min-width: 90px; }
.row-actions { display: inline-flex; gap: 0.35rem; }

/* フォロワー目標 */
.goal-form { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
.goal-form input[type="number"] { width: 10rem; }

/* オーディエンス */
#audience-content { display: flex; flex-direction: column; gap: 1.25rem; }
#audience-content.hidden { display: none; }
#audience-collected { margin: 0; }
#audience-city-table td:nth-child(2), #audience-city-table td:nth-child(3) { text-align: right; }

/* プレースホルダ */
.placeholder .ph-lead { font-size: 0.95rem; margin: 0.3rem 0; }
.placeholder .ph-sub { font-size: 0.85rem; color: var(--k-text-subtle); margin: 0 0 1rem; }
.ph-box { border: 1px dashed var(--k-line-strong); border-radius: var(--radius-lg); padding: 2.5rem; text-align: center; color: var(--k-text-subtle); font-size: 0.9rem; }

/* ツールチップ */
.tooltip { position: fixed; z-index: 20; pointer-events: none; background: var(--k-base); color: var(--k-text); border: 1px solid var(--k-line); border-radius: var(--radius-sm); padding: 0.4rem 0.55rem; font-size: 0.78rem; box-shadow: var(--shadow); max-width: 240px; }
.tooltip .tt-row { display: flex; align-items: center; gap: 0.35rem; white-space: nowrap; }
.tooltip .tt-row i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.tooltip .tt-title { font-weight: 600; margin-bottom: 0.15rem; }
.tooltip b { font-variant-numeric: tabular-nums; }
.loading { color: var(--k-text-subtle); font-size: 0.85rem; padding: 1rem 0; }

@media (max-width: 900px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  .chart-row { grid-template-columns: 1fr; }
  .sidebar { width: 60px; padding: 1.1rem 0.4rem; }
  .brand-name { display: none; }
  .nav-item span { display: none; }
  .nav-item { justify-content: center; padding: 0.6rem 0.2rem; }
  .post-item { grid-template-columns: 64px 1fr; }
  .post-thumb { width: 64px; height: 64px; }
  .post-spark { display: none; }
  .main { padding: 1rem 1rem 3rem; }
}
`;

const JS = `
(function () {
  var DATA = window.__DATA__;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var nf = new Intl.NumberFormat('ja-JP');
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var CAT = dark
    ? ['#3987e5','#199e70','#c98500','#008300','#9085e9','#e66767']
    : ['#2a78d6','#1baf7a','#eda100','#008300','#4a3aa7','#e34948'];
  // ?mock=1 のとき /ui/audience・/ui/app-settings をモックデータで代替する(バックエンド未実装時の表示検証用)。
  var MOCK = new URLSearchParams(location.search).get('mock');
  var jstHour = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  var state = { accountId: DATA.defaultAccountId, days: 30, bucket: 'day', managed: false, summary: null, diff: null, likes: null };
  // 週次/月次は「期間(state.days)」と独立した集計粒度でしかないため、期間セレクタが
  // 直近30日のままだと週次で数点、月次で1点しか出ない。バケット切替時に期間側も
  // 最低限のレンジへ引き上げる(period-select の既存 option 値 90/9999 を流用)。
  var BUCKET_MIN_DAYS = { week: 90, month: 9999 };

  function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888'; }
  function el(id) { return document.getElementById(id); }
  function isAll() { return state.accountId === 'all'; }

  function periodRange() {
    var days = state.days;
    var to = new Date();
    if (days >= 9999) return { from: null, to: null };
    var from = new Date(to.getTime() - days * 86400000);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  function qs(params) {
    return Object.keys(params).filter(function (k) { return params[k] !== null && params[k] !== undefined; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; });
  }

  // ---- SVG ----
  function mk(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]); } return e; }
  function newSvg(host, w, h) { host.innerHTML = ''; var svg = mk('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, preserveAspectRatio: 'xMidYMid meet' }); host.appendChild(svg); return svg; }

  var tip = el('tooltip');
  function showTip(html, evt) {
    tip.innerHTML = html; tip.hidden = false;
    var x = evt.clientX + 14, y = evt.clientY + 14; var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = evt.clientX - r.width - 14;
    if (y + r.height > window.innerHeight) y = evt.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }

  // マウスとタッチの両方でツールチップを出す(hover 不可端末でも値が必ず分かるように)。
  // move ハンドラは evt.clientX/clientY を参照するので、タッチは touches[0] を渡す。
  function bindPointer(target, move, leave) {
    target.addEventListener('mousemove', move);
    target.addEventListener('mouseleave', leave);
    target.addEventListener('touchstart', function (e) { if (e.touches && e.touches[0]) { move(e.touches[0]); e.preventDefault(); } }, { passive: false });
    target.addEventListener('touchmove', function (e) { if (e.touches && e.touches[0]) { move(e.touches[0]); e.preventDefault(); } }, { passive: false });
    target.addEventListener('touchend', leave);
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function fmtBucket(key) {
    if (!key) return '';
    if (key.length === 7) return key.replace('-', '/');
    var d = new Date(key); return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // ---- 面グラフ(フォロワー推移)----
  function renderFollowersArea() {
    var host = el('chart-followers');
    var buckets = state.diff ? state.diff.buckets : [];
    var W = 560, H = 260, mL = 52, mR = 14, mT = 12, mB = 26;
    var svg = newSvg(host, W, H);
    if (buckets.length === 0) { drawEmpty(svg, W, H); return; }
    var vals = buckets.map(function (b) { return b.followers; });
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    var pad = Math.max(1, (maxV - minV) * 0.12); minV -= pad; maxV += pad;
    var n = buckets.length, pw = W - mL - mR, ph = H - mT - mB;
    function x(i) { return mL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw); }
    function y(v) { return mT + ph - ((v - minV) / (maxV - minV)) * ph; }
    drawGridY(svg, minV, maxV, y, mL, W - mR, function (v) { return nf.format(Math.round(v)); });
    var dLine = '';
    buckets.forEach(function (b, i) { dLine += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(b.followers).toFixed(1) + ' '; });
    var dArea = dLine + 'L' + x(n - 1).toFixed(1) + ' ' + (mT + ph) + ' L' + x(0).toFixed(1) + ' ' + (mT + ph) + ' Z';
    svg.appendChild(mk('path', { d: dArea, fill: cssVar('--followers-fill'), stroke: 'none' }));
    svg.appendChild(mk('path', { d: dLine, fill: 'none', stroke: cssVar('--followers'), 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    drawXTicks(svg, buckets, x, mT + ph, function (b) { return fmtBucket(b.bucket_start); });
    // 最新値を常時ラベル表示(hover しなくても総数が分かるように)。
    var lastB = buckets[n - 1], lx = x(n - 1), ly = y(lastB.followers);
    var lastLbl = mk('text', { x: Math.min(lx - 4, W - mR), y: Math.max(mT + 10, ly - 8), 'font-size': 11, 'font-weight': 700, fill: cssVar('--followers'), 'text-anchor': 'end' });
    lastLbl.textContent = nf.format(lastB.followers); svg.appendChild(lastLbl);
    var cross = mk('line', { stroke: cssVar('--axis'), 'stroke-width': 1, y1: mT, y2: mT + ph, x1: -10, x2: -10 });
    var dot = mk('circle', { r: 4, fill: cssVar('--followers'), stroke: cssVar('--k-base'), 'stroke-width': 2, cx: -10, cy: -10 });
    svg.appendChild(cross); svg.appendChild(dot);
    var overlay = mk('rect', { x: mL, y: mT, width: pw, height: ph, fill: 'transparent' }); svg.appendChild(overlay);
    bindPointer(overlay, function (evt) {
      var rect = svg.getBoundingClientRect(); var sx = (evt.clientX - rect.left) * (W / rect.width);
      var i = n === 1 ? 0 : Math.round(((sx - mL) / pw) * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
      var b = buckets[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(b.followers));
      showTip('<div class="tt-title">' + fmtBucket(b.bucket_start) + '</div><div class="tt-row"><i style="background:' + cssVar('--followers') + '"></i>フォロワー <b>' + nf.format(b.followers) + '</b></div>', evt);
    }, function () { hideTip(); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); dot.setAttribute('cx', -10); });
  }

  // ---- いいね多系列 ----
  function renderLikes() {
    var host = el('chart-likes');
    var series = state.likes ? state.likes.series.filter(function (s) { return s.points.length > 0; }) : [];
    var W = 560, H = 260, mL = 52, mR = 60, mT = 12, mB = 26;
    var svg = newSvg(host, W, H); renderLikesLegend(series);
    if (series.length === 0) { drawEmpty(svg, W, H); return; }
    var allT = [], allV = [];
    series.forEach(function (s) { s.points.forEach(function (p) { allT.push(new Date(p.collected_at).getTime()); if (p.likes != null) allV.push(p.likes); }); });
    if (allV.length === 0) { drawEmpty(svg, W, H); return; }
    var minT = Math.min.apply(null, allT), maxT = Math.max.apply(null, allT); if (minT === maxT) { minT -= 86400000; maxT += 86400000; }
    var minV = 0, maxV = Math.max.apply(null, allV); maxV += Math.max(1, maxV * 0.12);
    var pw = W - mL - mR, ph = H - mT - mB;
    function x(t) { return mL + ((t - minT) / (maxT - minT)) * pw; }
    function y(v) { return mT + ph - ((v - minV) / (maxV - minV)) * ph; }
    drawGridY(svg, minV, maxV, y, mL, W - mR, function (v) { return nf.format(Math.round(v)); });
    series.forEach(function (s, si) {
      var color = CAT[si % CAT.length]; var d = '', drawn = 0, lastPt = null;
      s.points.forEach(function (p) { if (p.likes == null) return; var px = x(new Date(p.collected_at).getTime()), py = y(p.likes); d += (drawn === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; drawn++; lastPt = { px: px, py: py }; });
      if (drawn === 1 && lastPt) { svg.appendChild(mk('circle', { cx: lastPt.px, cy: lastPt.py, r: 4, fill: color, stroke: cssVar('--k-base'), 'stroke-width': 2 })); }
      else if (drawn > 1) { svg.appendChild(mk('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })); }
      if (lastPt) { var lbl = mk('text', { x: Math.min(lastPt.px + 6, W - 2), y: lastPt.py + 3, 'font-size': 10, fill: color, 'text-anchor': 'start' }); lbl.textContent = fmtBucket((s.posted_at || '').slice(0, 10) || ''); svg.appendChild(lbl); }
    });
    drawXTimeTicks(svg, minT, maxT, x, mT + ph);
    var overlay = mk('rect', { x: mL, y: mT, width: pw, height: ph, fill: 'transparent' }); svg.appendChild(overlay);
    bindPointer(overlay, function (evt) {
      var rect = svg.getBoundingClientRect(); var sx = (evt.clientX - rect.left) * (W / rect.width); var t = minT + ((sx - mL) / pw) * (maxT - minT); var rows = '';
      series.forEach(function (s, si) { var best = null, bd = Infinity; s.points.forEach(function (p) { if (p.likes == null) return; var dd = Math.abs(new Date(p.collected_at).getTime() - t); if (dd < bd) { bd = dd; best = p; } }); if (best) { rows += '<div class="tt-row"><i style="background:' + CAT[si % CAT.length] + '"></i>' + (fmtBucket((s.posted_at || '').slice(0,10) || '')) + ' <b>' + nf.format(best.likes) + '</b></div>'; } });
      if (rows) showTip(rows, evt);
    }, hideTip);
  }
  function renderLikesLegend(series) {
    var lg = el('likes-legend'); lg.innerHTML = '';
    series.forEach(function (s, si) { var span = document.createElement('span'); span.className = 'lg'; var label = (s.posted_at ? fmtBucket(s.posted_at.slice(0,10)) : (s.external_id || '')) + '(' + (s.latest_likes == null ? 'N/A' : nf.format(s.latest_likes)) + ')'; span.innerHTML = '<i style="background:' + CAT[si % CAT.length] + '"></i>' + label; lg.appendChild(span); });
  }

  // ---- 増減バー(共通: buckets を渡す) ----
  function renderDiffBarInto(hostId, buckets, W) {
    var host = el(hostId);
    W = W || 1130; var H = 220, mL = 52, mR = 14, mT = 12, mB = 40;
    var svg = newSvg(host, W, H);
    if (!buckets || buckets.length === 0) { drawEmpty(svg, W, H); return; }
    var nets = buckets.map(function (b) { return b.net; });
    var maxV = Math.max.apply(null, nets.concat([0])), minV = Math.min.apply(null, nets.concat([0]));
    if (maxV === minV) { maxV += 1; minV -= 1; }
    var span = maxV - minV; maxV += span * 0.1; minV -= span * 0.1;
    var n = buckets.length, pw = W - mL - mR, ph = H - mT - mB;
    function y(v) { return mT + ph - ((v - minV) / (maxV - minV)) * ph; }
    var y0 = y(0), slot = pw / n, bw = Math.max(2, Math.min(slot - 2, 26));
    drawGridY(svg, minV, maxV, y, mL, W - mR, function (v) { return (v > 0 ? '+' : '') + nf.format(Math.round(v)); });
    svg.appendChild(mk('line', { x1: mL, x2: W - mR, y1: y0, y2: y0, stroke: cssVar('--axis'), 'stroke-width': 1 }));
    buckets.forEach(function (b, i) {
      var cx = mL + slot * i + slot / 2, up = b.net >= 0, yv = y(b.net); var top = up ? yv : y0; var hgt = Math.max(1, Math.abs(yv - y0));
      var color = up ? cssVar('--up') : cssVar('--down');
      var rect = mk('rect', { x: cx - bw / 2, y: top, width: bw, height: hgt, rx: 3, fill: color });
      var tipHtml = '<div class="tt-title">' + (b.label || fmtBucket(b.bucket_start)) + '</div><div class="tt-row"><i style="background:' + color + '"></i>純増減 <b>' + (up ? '+' : '') + nf.format(b.net) + '</b></div>';
      rect.addEventListener('mouseenter', function (evt) { showTip(tipHtml, evt); });
      rect.addEventListener('mousemove', function (evt) { showTip(tipHtml, evt); });
      rect.addEventListener('mouseleave', hideTip);
      rect.addEventListener('touchstart', function (evt) { if (evt.touches && evt.touches[0]) { showTip(tipHtml, evt.touches[0]); evt.preventDefault(); } }, { passive: false });
      svg.appendChild(rect);
      // バー間隔が十分なら値を常時ラベル表示(タッチ端末でも総数が分かるように)。
      if (slot >= 24) {
        var vly = up ? Math.max(mT + 8, yv - 3) : Math.min(mT + ph + mB - 26, yv + 10);
        var vlbl = mk('text', { x: cx, y: vly, 'font-size': 9, fill: cssVar('--k-text-subtle'), 'text-anchor': 'middle' });
        vlbl.textContent = (b.net > 0 ? '+' : '') + nf.format(b.net); svg.appendChild(vlbl);
      }
    });
    drawXTicks(svg, buckets, function (i) { return mL + slot * i + slot / 2; }, mT + ph, function (b) { return b.label || fmtBucket(b.bucket_start); });
  }
  function renderDiffBar() { renderDiffBarInto('chart-diff', state.diff ? state.diff.buckets : [], 1130); }

  // ---- 軸/グリッド ----
  function drawGridY(svg, minV, maxV, y, x1, x2, fmt) {
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) { var v = minV + (t / ticks) * (maxV - minV); var yy = y(v);
      svg.appendChild(mk('line', { x1: x1, x2: x2, y1: yy, y2: yy, stroke: cssVar('--grid'), 'stroke-width': 1 }));
      var lbl = mk('text', { x: x1 - 6, y: yy + 3, 'font-size': 10, fill: cssVar('--k-text-subtle'), 'text-anchor': 'end' }); lbl.textContent = fmt(v); svg.appendChild(lbl); }
  }
  function drawXTicks(svg, items, xf, yBase, fmt) {
    var n = items.length, step = Math.max(1, Math.ceil(n / 8));
    for (var i = 0; i < n; i += step) { var lbl = mk('text', { x: xf(i), y: yBase + 15, 'font-size': 10, fill: cssVar('--k-text-subtle'), 'text-anchor': 'middle' }); lbl.textContent = fmt(items[i]); svg.appendChild(lbl); }
  }
  function drawXTimeTicks(svg, minT, maxT, x, yBase) {
    var ticks = 5;
    for (var t = 0; t <= ticks; t++) { var tt = minT + (t / ticks) * (maxT - minT); var d = new Date(tt); var lbl = mk('text', { x: x(tt), y: yBase + 15, 'font-size': 10, fill: cssVar('--k-text-subtle'), 'text-anchor': 'middle' }); lbl.textContent = (d.getMonth() + 1) + '/' + d.getDate(); svg.appendChild(lbl); }
  }
  function drawEmpty(svg, W, H) { var t = mk('text', { x: W / 2, y: H / 2, 'font-size': 12, fill: cssVar('--k-text-subtle'), 'text-anchor': 'middle' }); t.textContent = 'データがありません'; svg.appendChild(t); }

  function sparkline(host, values, color, w, h) {
    var svg = newSvg(host, w, h); svg.setAttribute('preserveAspectRatio', 'none');
    var vals = (values || []).filter(function (v) { return typeof v === 'number'; });
    if (vals.length < 2) return;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals); if (min === max) { min -= 1; max += 1; }
    var n = vals.length, pad = 2;
    function x(i) { return pad + (i / (n - 1)) * (w - 2 * pad); }
    function y(v) { return h - pad - ((v - min) / (max - min)) * (h - 2 * pad); }
    var d = ''; vals.forEach(function (v, i) { d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
    svg.appendChild(mk('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  // ---- KPI ----
  function renderKPIs() {
    var s = state.summary; var grid = el('kpi-grid'); grid.innerHTML = '';
    if (!s) { grid.innerHTML = '<div class="loading">読込中...</div>'; return; }
    function badge(delta, pct) {
      if (delta == null) return '<span class="kpi-badge muted">前日比 —</span>';
      var up = delta >= 0; var arrow = up ? '▲' : '▼'; var pctTxt = pct == null ? '' : ' (' + (up ? '+' : '') + (pct * 100).toFixed(2) + '%)';
      return '<span class="kpi-badge ' + (up ? 'up' : 'down') + '">' + arrow + ' ' + (up ? '+' : '') + nf.format(delta) + pctTxt + '</span>';
    }
    var cards = [
      { label: 'フォロワー総数', value: s.followers == null ? '—' : nf.format(s.followers), cls: '', badge: badge(s.day_delta, s.day_pct), spark: s.sparkline, sparkColor: cssVar('--followers') },
      { label: '前日比増減', value: (s.day_delta == null ? '—' : (s.day_delta >= 0 ? '+' : '') + nf.format(s.day_delta)), cls: s.day_delta == null ? '' : (s.day_delta >= 0 ? 'up' : 'down'), badge: s.day_pct == null ? '<span class="kpi-badge muted">—</span>' : '<span class="kpi-badge ' + (s.day_delta >= 0 ? 'up' : 'down') + '">' + (s.day_delta >= 0 ? '+' : '') + (s.day_pct * 100).toFixed(2) + '%</span>', spark: null },
      { label: '期間純増', value: (s.period_net == null ? '—' : (s.period_net >= 0 ? '+' : '') + nf.format(s.period_net)), cls: 'net', badge: s.period_pct == null ? '<span class="kpi-badge muted">—</span>' : '<span class="kpi-badge ' + (s.period_net >= 0 ? 'up' : 'down') + '">' + (s.period_net >= 0 ? '+' : '') + (s.period_pct * 100).toFixed(2) + '%</span>', spark: s.sparkline, sparkColor: cssVar('--violet') },
      { label: '直近投稿の平均いいね', value: s.avg_likes_recent == null ? '—' : nf.format(s.avg_likes_recent), cls: '', badge: '<span class="kpi-badge muted">直近' + s.recent_post_count + '投稿</span>', spark: null }
    ];
    cards.forEach(function (c) {
      var div = document.createElement('div'); div.className = 'kpi';
      div.innerHTML = '<div class="kpi-label">' + c.label + '</div><div class="kpi-value ' + c.cls + '">' + c.value + '</div>' + c.badge;
      var sp = document.createElement('div'); sp.className = 'kpi-spark'; div.appendChild(sp); grid.appendChild(div);
      if (c.spark) sparkline(sp, c.spark, c.sparkColor || cssVar('--k-interactive'), 200, 34);
    });
  }

  // ---- 投稿別分析(サムネ + 全文キャプション) ----
  function renderPosts() {
    var container = el('posts-list'); container.innerHTML = '<div class="loading">読込中...</div>';
    el('posts-hint').textContent = state.managed ? 'reach / saved も表示(管理アカウント)' : '';
    if (isAll()) { container.innerHTML = '<p class="loading">アカウントを選択すると投稿を表示します</p>'; return; }
    fetch('/ui/posts?account_id=' + encodeURIComponent(state.accountId) + '&limit=20')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var posts = data.posts || [];
        if (posts.length === 0) { container.innerHTML = '<p class="loading">投稿データがありません</p>'; return; }
        container.innerHTML = '';
        posts.forEach(function (p) {
          var latest = p.latest || {};
          var item = document.createElement('div'); item.className = 'post-item';
          var metrics = 'いいね <b>' + (latest.likes == null ? 'N/A' : nf.format(latest.likes)) + '</b>' +
            ' ・ コメント <b>' + (latest.comments == null ? 'N/A' : nf.format(latest.comments)) + '</b>' +
            ' ・ 再生 <b>' + (latest.views == null ? 'N/A' : nf.format(latest.views)) + '</b>';
          if (state.managed) { metrics += ' ・ リーチ <b>' + (latest.reach == null ? 'N/A' : nf.format(latest.reach)) + '</b> ・ 保存 <b>' + (latest.saved == null ? 'N/A' : nf.format(latest.saved)) + '</b>'; }
          var cap = p.caption_full || p.caption_head || '(キャプションなし)';
          var thumb = document.createElement('img'); thumb.className = 'post-thumb'; thumb.loading = 'lazy'; thumb.alt = '';
          thumb.src = '/img/' + p.id;
          var main = document.createElement('div'); main.className = 'post-main';
          main.innerHTML = '<div class="post-cap">' + escapeHtml(cap) + '</div><div class="post-metrics">' + metrics + '</div>' +
            '<div class="post-date">' + escapeHtml((p.posted_at || '').slice(0,10)) + (p.url ? ' — <a href="' + encodeURI(p.url) + '" target="_blank" rel="noreferrer">投稿を開く</a>' : '') + '</div>';
          var spark = document.createElement('div'); spark.className = 'post-spark';
          item.appendChild(thumb); item.appendChild(main); item.appendChild(spark);
          container.appendChild(item);
          sparkline(spark, p.sparkline && p.sparkline.length ? p.sparkline : [0, 0], cssVar('--k-interactive'), 130, 40);
          var sv = spark.querySelector('svg');
          if (sv && latest.likes != null) {
            var vt = mk('text', { x: 128, y: 12, 'font-size': 10, 'font-weight': 700, 'text-anchor': 'end', fill: cssVar('--k-interactive') });
            vt.textContent = nf.format(latest.likes); sv.appendChild(vt);
          }
        });
      })
      .catch(function () { container.innerHTML = '<p class="loading">読込に失敗しました</p>'; });
  }

  // ---- 全アカウント概要 ----
  function loadAllOverview() {
    var r = periodRange();
    el('account-grid').innerHTML = '<div class="loading">読込中...</div>';
    el('all-hint').textContent = '';
    fetch('/ui/overview?' + qs({ from: r.from, to: r.to })).then(function (x) { return x.json(); }).then(function (res) {
      var items = res.overview || [];
      renderAccountGrid(items);
      renderAccountsNetBar(items);
    }).catch(function () { el('account-grid').innerHTML = '<div class="loading">読込に失敗しました</div>'; });
  }
  function renderAccountGrid(items) {
    var grid = el('account-grid'); grid.innerHTML = '';
    el('all-hint').textContent = items.length + ' アカウント';
    if (items.length === 0) { grid.innerHTML = '<p class="loading">アクティブなアカウントがありません</p>'; return; }
    items.forEach(function (it) {
      var card = document.createElement('div'); card.className = 'acc-card';
      var dd = it.day_delta, pn = it.period_net;
      var ddHtml = dd == null ? '<span class="acc-deltas">前日比 —</span>' : '<span class="' + (dd >= 0 ? 'acc-up' : 'acc-down') + '">' + (dd >= 0 ? '▲ +' : '▼ ') + nf.format(dd) + '</span>';
      var pnHtml = pn == null ? '—' : '<b class="' + (pn >= 0 ? 'acc-up' : 'acc-down') + '">' + (pn >= 0 ? '+' : '') + nf.format(pn) + '</b>';
      card.innerHTML = '<div class="acc-name">' + escapeHtml(it.display_name || it.handle) + ' <span class="acc-plat">' + it.platform_id + '</span></div>' +
        '<div class="acc-followers">' + (it.followers == null ? '—' : nf.format(it.followers)) + '</div>' +
        '<div class="acc-deltas"><span>前日比 ' + ddHtml + '</span><span>期間 ' + pnHtml + '</span></div>' +
        '<div class="acc-spark"></div>';
      card.addEventListener('click', function () { selectAccount(it.account_id); });
      grid.appendChild(card);
      sparkline(card.querySelector('.acc-spark'), it.sparkline, cssVar('--followers'), 200, 30);
    });
  }
  // 横棒グラフ: 縦軸に全アカウント名(間引きなし)、横にゼロ基準の発散バー + 値ラベル。
  function renderAccountsNetBar(items) {
    var host = el('chart-accounts-net');
    var rows = items.map(function (it) { return { name: (it.display_name || it.handle), net: it.period_net == null ? 0 : it.period_net }; });
    rows.sort(function (a, b) { return b.net - a.net; });
    var W = 1130, rowH = 30, mT = 8, mB = 8, labelW = 210, valW = 74;
    var H = mT + mB + Math.max(1, rows.length) * rowH;
    var svg = newSvg(host, W, H);
    if (rows.length === 0) { drawEmpty(svg, W, 120); return; }
    // ゼロを自然な位置に置く: 全て正なら左端、全て負なら右端、混在なら比例位置。
    var nets = rows.map(function (r) { return r.net; });
    var lo = Math.min(0, Math.min.apply(null, nets)), hi = Math.max(0, Math.max.apply(null, nets));
    if (hi === lo) hi = lo + 1;
    var plotL = labelW, plotR = W - valW, plotW = plotR - plotL;
    function bx(v) { return plotL + ((v - lo) / (hi - lo)) * plotW; }
    var zx = bx(0);
    svg.appendChild(mk('line', { x1: zx, x2: zx, y1: mT, y2: H - mB, stroke: cssVar('--axis'), 'stroke-width': 1 }));
    rows.forEach(function (r, i) {
      var cy = mT + i * rowH + rowH / 2, up = r.net >= 0, x2 = bx(r.net);
      var color = up ? cssVar('--up') : cssVar('--down');
      var rx = Math.min(zx, x2), rw = Math.max(1, Math.abs(x2 - zx));
      svg.appendChild(mk('rect', { x: rx, y: cy - 8, width: rw, height: 16, rx: 3, fill: color }));
      var nm = mk('text', { x: labelW - 8, y: cy + 4, 'font-size': 11, fill: cssVar('--k-text'), 'text-anchor': 'end' });
      nm.textContent = trunc(r.name, 24); svg.appendChild(nm);
      var vlbl = mk('text', { x: W - 6, y: cy + 4, 'font-size': 11, 'font-weight': 700, fill: color, 'text-anchor': 'end' });
      vlbl.textContent = (r.net > 0 ? '+' : '') + nf.format(r.net); svg.appendChild(vlbl);
      // 行全体をホバー/タップ領域に(名前が切り詰められても full name + 値が読めるように)。
      var hit = mk('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: 'transparent' });
      var tipHtml = '<div class="tt-title">' + escapeHtml(r.name) + '</div><div class="tt-row"><i style="background:' + color + '"></i>期間純増 <b>' + (r.net > 0 ? '+' : '') + nf.format(r.net) + '</b></div>';
      bindPointer(hit, function (evt) { showTip(tipHtml, evt); }, hideTip);
      svg.appendChild(hit);
    });
  }

  // ---- データ取得(単一アカウント) ----
  function loadOverview() {
    if (isAll()) { el('overview-single').classList.add('hidden'); el('overview-all').classList.remove('hidden'); loadAllOverview(); return; }
    el('overview-single').classList.remove('hidden'); el('overview-all').classList.add('hidden');
    var r = periodRange(); el('kpi-grid').innerHTML = '<div class="loading">読込中...</div>';
    var base = { account_id: state.accountId, from: r.from, to: r.to };
    Promise.all([
      fetch('/ui/summary?' + qs(base)).then(function (x) { return x.json(); }),
      fetch('/ui/followers/diff?' + qs(Object.assign({ bucket: state.bucket }, base))).then(function (x) { return x.json(); }),
      fetch('/ui/likes/series?' + qs({ account_id: state.accountId, limit: 6 })).then(function (x) { return x.json(); })
    ]).then(function (res) {
      state.summary = res[0].summary || null; state.diff = res[1].diff || null; state.likes = res[2].likes || null;
      renderKPIs(); renderFollowersArea(); renderLikes(); renderDiffBar();
    }).catch(function () { el('kpi-grid').innerHTML = '<div class="loading">読込に失敗しました</div>'; });
  }
  function reloadDiffOnly() {
    if (isAll()) return;
    var r = periodRange();
    fetch('/ui/followers/diff?' + qs({ account_id: state.accountId, from: r.from, to: r.to, bucket: state.bucket })).then(function (x) { return x.json(); }).then(function (res) { state.diff = res.diff || null; renderFollowersArea(); renderDiffBar(); });
  }

  // ---- オーディエンス ----
  // 横棒グラフ(0基準・単系列)。年齢・性別で共用。値は常時ラベル表示。
  function renderHBarChart(hostId, rows, valueSuffix) {
    var host = el(hostId);
    var W = 520, rowH = 30, mT = 6, mB = 6, labelW = 90, valW = 66;
    var H = mT + mB + Math.max(1, rows.length) * rowH;
    var svg = newSvg(host, W, H);
    if (!rows || rows.length === 0) { drawEmpty(svg, W, 90); return; }
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var plotL = labelW, plotR = W - valW, plotW = plotR - plotL;
    rows.forEach(function (r, i) {
      var cy = mT + i * rowH + rowH / 2;
      var bw = maxV > 0 ? Math.max(1, (r.value / maxV) * plotW) : 1;
      svg.appendChild(mk('rect', { x: plotL, y: cy - 9, width: bw, height: 18, rx: 3, fill: cssVar('--k-interactive') }));
      var nm = mk('text', { x: labelW - 8, y: cy + 4, 'font-size': 11, fill: cssVar('--k-text'), 'text-anchor': 'end' });
      nm.textContent = r.label; svg.appendChild(nm);
      var vl = mk('text', { x: plotL + bw + 6, y: cy + 4, 'font-size': 11, 'font-weight': 700, fill: cssVar('--k-text'), 'text-anchor': 'start' });
      vl.textContent = nf.format(r.value) + (valueSuffix || ''); svg.appendChild(vl);
    });
  }
  // 時間帯棒グラフ(0-23時、JST表記)。online_followers 用。
  function renderHourBars(hostId, rows) {
    var host = el(hostId);
    var W = 560, H = 180, mL = 34, mR = 10, mT = 10, mB = 26;
    var svg = newSvg(host, W, H);
    if (!rows || rows.length === 0) { drawEmpty(svg, W, H); return; }
    var byHour = {};
    rows.forEach(function (r) { byHour[Number(r.bucket)] = r.value; });
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var n = 24, pw = W - mL - mR, ph = H - mT - mB, slot = pw / n, bw = Math.max(2, Math.min(slot - 2, 20));
    function y(v) { return mT + ph - (maxV > 0 ? (v / maxV) * ph : 0); }
    for (var h = 0; h < 24; h++) {
      var v = byHour[h] || 0;
      var cx = mL + slot * h + slot / 2, top = y(v), hgt = Math.max(1, mT + ph - top);
      var rect = mk('rect', { x: cx - bw / 2, y: top, width: bw, height: hgt, rx: 2, fill: cssVar('--k-interactive') });
      var title = mk('title', {}); title.textContent = h + '時: ' + nf.format(v) + '人'; rect.appendChild(title);
      svg.appendChild(rect);
      if (h % 3 === 0) { var lbl = mk('text', { x: cx, y: mT + ph + 15, 'font-size': 9, fill: cssVar('--k-text-subtle'), 'text-anchor': 'middle' }); lbl.textContent = h + '時'; svg.appendChild(lbl); }
    }
  }
  var GENDER_LABEL = { F: '女性', M: '男性', U: '不明' };
  function renderAudiencePlaceholder() {
    el('audience-placeholder').classList.remove('hidden');
    el('audience-content').classList.add('hidden');
  }
  function mockAudience() {
    return {
      audience: {
        collected_at: '2026-07-15T09:00:00Z',
        kinds: {
          demographics_age: [{ bucket: '18-24', value: 210 }, { bucket: '13-17', value: 120 }, { bucket: '25-34', value: 64 }, { bucket: '35-44', value: 18 }],
          demographics_gender: [{ bucket: 'F', value: 300 }, { bucket: 'M', value: 108 }, { bucket: 'U', value: 4 }],
          demographics_city: [{ bucket: 'Fukuoka', value: 88 }, { bucket: 'Kitakyushu', value: 41 }, { bucket: 'Kurume', value: 22 }, { bucket: 'Osaka', value: 15 }, { bucket: 'Tokyo', value: 12 }],
          online_followers: []
        }
      }
    };
  }
  function loadAudience() {
    if (isAll() || !state.managed) { renderAudiencePlaceholder(); return; }
    var url = '/ui/audience?account_id=' + encodeURIComponent(state.accountId);
    var p = MOCK ? Promise.resolve(mockAudience()) : fetch(url).then(function (r) { return r.json(); });
    p.then(function (data) {
      var audience = (data && data.audience) || { collected_at: null, kinds: {} };
      var kinds = audience.kinds || {};
      var hasData = !!audience.collected_at && Object.keys(kinds).some(function (k) { return (kinds[k] || []).length > 0; });
      if (!hasData) { renderAudiencePlaceholder(); return; }
      el('audience-placeholder').classList.add('hidden');
      el('audience-content').classList.remove('hidden');
      var d = new Date(audience.collected_at);
      el('audience-collected').textContent = '取得日: ' + (isNaN(d.getTime()) ? audience.collected_at : jstHour.format(d));
      renderHBarChart('chart-audience-age', (kinds.demographics_age || []).map(function (r) { return { label: r.bucket + '歳', value: r.value }; }), '人');
      renderHBarChart('chart-audience-gender', (kinds.demographics_gender || []).map(function (r) { return { label: GENDER_LABEL[r.bucket] || r.bucket, value: r.value }; }), '人');
      var cities = (kinds.demographics_city || []).slice(0, 10);
      var totalCity = cities.reduce(function (a, r) { return a + r.value; }, 0);
      var thead = '<thead><tr><th>都市</th><th>フォロワー数</th><th>割合</th></tr></thead>';
      var rows = cities.map(function (r) {
        var pctTxt = totalCity > 0 ? ((r.value / totalCity) * 100).toFixed(1) + '%' : '—';
        return '<tr><td>' + escapeHtml(r.bucket) + '</td><td>' + nf.format(r.value) + '</td><td>' + pctTxt + '</td></tr>';
      }).join('');
      el('audience-city-table').innerHTML = cities.length ? thead + '<tbody>' + rows + '</tbody>' : '<tbody><tr><td>データがありません</td></tr></tbody>';
      var hours = kinds.online_followers || [];
      var hoursHost = el('chart-audience-hours');
      if (hours.length === 0) { hoursHost.innerHTML = ''; el('audience-hours-note').hidden = false; }
      else { el('audience-hours-note').hidden = true; renderHourBars('chart-audience-hours', hours); }
    }).catch(function () { renderAudiencePlaceholder(); });
  }

  // ---- 設定: 権限ゲート(v11)。SETTINGS_PASSWORD 未設定なら常に開放 ----
  function showSettingsLock(locked) {
    el('settings-lock').hidden = !locked;
    el('settings-content').hidden = locked;
  }
  function checkSettingsAuth() {
    if (MOCK) { showSettingsLock(false); return; }
    fetch('/ui/auth/status').then(function (r) { return r.json(); }).then(function (st) {
      showSettingsLock(!!(st.required && !st.authed));
    }).catch(function () { showSettingsLock(false); });
  }
  function wireSettingsLock() {
    el('settings-lock-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var status = el('settings-lock-status'); status.textContent = '確認中...';
      fetch('/ui/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: el('settings-password').value })
      }).then(function (r) {
        if (r.ok) { status.textContent = ''; el('settings-password').value = ''; showSettingsLock(false); loadGoal(); }
        else { status.textContent = 'パスワードが違います'; }
      }).catch(function () { status.textContent = '通信に失敗しました'; });
    });
  }

  // ---- 設定: フォロワー目標 ----
  function loadGoal() {
    var p = MOCK ? Promise.resolve({ settings: { follower_goal: '1000' } }) : fetch('/ui/app-settings').then(function (r) { return r.json(); });
    p.then(function (res) {
      var v = res && res.settings && res.settings.follower_goal;
      el('goal-input').value = v == null ? '' : v;
    }).catch(function () {});
  }
  function wireGoalForm() {
    el('goal-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var status = el('goal-status'); status.textContent = '保存中...';
      var val = el('goal-input').value.trim();
      fetch('/ui/app-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'follower_goal', value: val }) })
        .then(function (rr) {
          if (rr.status === 401) { status.textContent = ''; showSettingsLock(true); return; }
          status.textContent = rr.ok ? '保存しました' : '保存に失敗しました';
        })
        .catch(function () { status.textContent = '保存に失敗しました'; });
    });
  }

  // ---- ナビ ----
  function switchView(name) {
    ['overview', 'posts', 'audience', 'settings', 'events'].forEach(function (v) { el('view-' + v).classList.toggle('hidden', v !== name); });
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); });
    if (name === 'posts') renderPosts();
    if (name === 'audience') loadAudience();
    if (name === 'settings') checkSettingsAuth();
  }

  // ---- 設定: アカウント管理(全項目編集 + 削除) ----
  function renderAccountsTable() {
    var table = el('accounts-table');
    var thead = '<thead><tr><th>ID</th><th>platform</th><th>handle</th><th>表示名</th><th>active</th><th>managed</th><th></th></tr></thead>';
    var rows = DATA.accounts.map(function (a) {
      return '<tr data-id="' + a.id + '" data-platform="' + a.platform_id + '">' +
        '<td>' + a.id + '</td><td>' + a.platform_id + '</td>' +
        '<td><input class="edit-input f-handle" value="' + escapeAttr(a.handle) + '" /></td>' +
        '<td><input class="edit-input f-display" value="' + escapeAttr(a.display_name || '') + '" placeholder="—" /></td>' +
        '<td><input type="checkbox" class="f-active" ' + (a.active ? 'checked' : '') + ' /></td>' +
        '<td><input type="checkbox" class="f-managed" ' + (a.managed ? 'checked' : '') + ' /></td>' +
        '<td><span class="row-actions"><button class="btn btn-primary btn-sm act-save">保存</button><button class="btn btn-danger btn-sm act-del">削除</button></span></td></tr>';
    }).join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      var id = tr.dataset.id;
      tr.querySelector('.act-save').addEventListener('click', function () {
        var patch = { handle: tr.querySelector('.f-handle').value.trim(), display_name: tr.querySelector('.f-display').value.trim() || null, active: tr.querySelector('.f-active').checked, managed: tr.querySelector('.f-managed').checked };
        if (!patch.handle) { alert('handle は必須です'); return; }
        fetch('/ui/accounts/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
          .then(function (rr) { if (rr.ok) location.reload(); else if (rr.status === 401) showSettingsLock(true); else rr.json().then(function (j) { alert(j.error || '保存に失敗しました'); }); });
      });
      tr.querySelector('.act-del').addEventListener('click', function () {
        if (!confirm('このアカウントと全ての時系列データを削除します。よろしいですか?')) return;
        fetch('/ui/accounts/' + id, { method: 'DELETE' }).then(function (rr) { if (rr.ok) location.reload(); else if (rr.status === 401) showSettingsLock(true); else alert('削除に失敗しました'); });
      });
    });
  }
  function escapeAttr(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function wireAddAccountForm() {
    var form = el('add-account-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var fd = new FormData(form);
      fetch('/ui/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform_id: fd.get('platform_id'), handle: fd.get('handle'), display_name: fd.get('display_name') || null, managed: fd.get('managed') === 'on' }) })
        .then(function (rr) { if (rr.ok) location.reload(); else if (rr.status === 401) showSettingsLock(true); else rr.json().then(function (j) { alert(j.error || '追加に失敗しました'); }); });
    });
  }

  // ---- イベント ----
  function typeLabel(t) { return t === 'anomaly' ? '急変動' : t === 'collect_fail' ? '収集失敗' : t === 'stale' ? '鮮度切れ' : t; }
  function badgeClass(t) { return t === 'collect_fail' ? 'badge-danger' : t === 'anomaly' ? 'badge-warning' : 'badge-neutral'; }
  function renderEvents() {
    var container = el('events-list'); container.innerHTML = '';
    if (!DATA.events || DATA.events.length === 0) { container.innerHTML = '<p class="loading">イベントはありません</p>'; return; }
    DATA.events.forEach(function (ev) {
      var item = document.createElement('div'); item.className = 'event-item' + (ev.acknowledged ? ' acked' : '');
      var meta = document.createElement('div');
      meta.innerHTML = '<span class="badge ' + badgeClass(ev.type) + '">' + typeLabel(ev.type) + '</span> <strong>' + escapeHtml(ev.message) + '</strong><div class="event-meta">' + ev.created_at + '</div>';
      var btn = document.createElement('button'); btn.className = 'btn btn-ghost btn-sm'; btn.textContent = ev.acknowledged ? '未確認に戻す' : '確認済にする';
      btn.addEventListener('click', function () { fetch('/ui/events/' + ev.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledged: !ev.acknowledged }) }).then(function () { location.reload(); }); });
      item.appendChild(meta); item.appendChild(btn); container.appendChild(item);
    });
  }

  // ---- アカウントセレクト ----
  function selectAccount(id) {
    var sel = el('account-select'); sel.value = String(id); sel.dispatchEvent(new Event('change'));
  }
  function updateManagedAndLink() {
    var sel = el('account-select'); var o = sel.options[sel.selectedIndex];
    state.managed = o && o.dataset.managed === '1';
    el('monitor-link').href = isAll() ? '/monitor' : '/monitor?account_id=' + state.accountId;
  }
  function renderAccountSelect() {
    var sel = el('account-select'); sel.innerHTML = '';
    var allOpt = document.createElement('option'); allOpt.value = 'all'; allOpt.textContent = '全アカウント'; allOpt.dataset.managed = '0'; sel.appendChild(allOpt);
    DATA.accounts.filter(function (a) { return a.active; }).forEach(function (a) {
      var opt = document.createElement('option'); opt.value = a.id; opt.dataset.managed = a.managed ? '1' : '0'; opt.textContent = (a.display_name || a.handle);
      if (a.id === state.accountId) opt.selected = true; sel.appendChild(opt);
    });
    updateManagedAndLink();
    sel.addEventListener('change', function () {
      state.accountId = sel.value === 'all' ? 'all' : Number(sel.value);
      updateManagedAndLink();
      loadOverview();
      if (!el('view-posts').classList.contains('hidden')) renderPosts();
      if (!el('view-audience').classList.contains('hidden')) loadAudience();
    });
  }

  // ---- 初期化 ----
  el('period-select').addEventListener('change', function () {
    state.days = Number(this.value);
    // 期間を狭めた結果いま選択中のバケットが成立しなくなったら日次に戻す(週次/月次のまま
    // 極端に狭い期間を見せて点がほぼ出ない状態を防ぐ)。
    var minDays = BUCKET_MIN_DAYS[state.bucket];
    if (minDays && state.days < minDays) {
      state.bucket = 'day';
      el('bucket-seg').querySelectorAll('button').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.bucket === 'day'); });
    }
    loadOverview();
  });
  el('bucket-seg').addEventListener('click', function (e) {
    var b = e.target && e.target.dataset ? e.target.dataset.bucket : null; if (!b) return; state.bucket = b;
    this.querySelectorAll('button').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.bucket === b); });
    var minDays = BUCKET_MIN_DAYS[b];
    if (minDays && state.days < minDays) {
      // 週次/月次に見合うレンジへ期間セレクタごと引き上げる。KPI も期間に連動するため
      // (diff だけの reloadDiffOnly ではなく) loadOverview で summary/likes も揃えて再取得する。
      state.days = minDays;
      el('period-select').value = String(minDays);
      loadOverview();
    } else {
      reloadDiffOnly();
    }
  });
  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.nav-item') : null; if (btn && btn.dataset.view) switchView(btn.dataset.view);
  });

  renderAccountSelect();
  renderAccountsTable();
  wireAddAccountForm();
  wireGoalForm();
  loadGoal();
  wireSettingsLock();
  renderEvents();
  loadOverview();
})();
`;
